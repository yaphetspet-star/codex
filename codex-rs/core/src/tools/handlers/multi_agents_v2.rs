//! Implements the MultiAgentV2 collaboration tool surface.

use crate::agent::AgentStatus;
use crate::agent::agent_resolver::resolve_agent_target;
use crate::context::ContextualUserFragment;
use crate::context::InterAgentMessage;
use crate::context::InterAgentMessageType;
use crate::function_tool::FunctionCallError;
use crate::tools::context::ToolCallSource;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::context::boxed_tool_output;
use crate::tools::handlers::multi_agents_common::*;
use crate::tools::handlers::parse_arguments;
use crate::tools::registry::CoreToolRuntime;
use crate::tools::registry::ToolExecutor;
use codex_protocol::AgentPath;
use codex_protocol::items::CollabAgentTool;
use codex_protocol::items::CollabAgentToolCallItem;
use codex_protocol::items::CollabAgentToolCallStatus;
use codex_protocol::items::SubAgentActivityItem;
use codex_protocol::items::TurnItem;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::InterAgentCommunication;
use codex_protocol::protocol::SubAgentActivityKind;
use codex_tools::ToolName;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;

pub(crate) use followup_task::Handler as FollowupTaskHandler;
pub(crate) use interrupt_agent::Handler as InterruptAgentHandler;
pub(crate) use list_agents::Handler as ListAgentsHandler;
pub(crate) use send_message::Handler as SendMessageHandler;
pub(crate) use spawn::Handler as SpawnAgentHandler;
pub(crate) use wait::Handler as WaitAgentHandler;

mod analytics;
mod followup_task;
mod interrupt_agent;
mod list_agents;
mod message_tool;
mod send_message;
mod spawn;
pub(crate) mod wait;

pub(crate) async fn emit_sub_agent_activity(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    item: SubAgentActivityItem,
) {
    let item = TurnItem::SubAgentActivity(item);
    session.emit_turn_item_started(turn, &item).await;
    session.emit_turn_item_completed(turn, item).await;
}

/// How an inter-agent payload is carried to the recipient.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InterAgentPayloadFormat {
    /// The payload rides in an `encrypted_content` item, invisible in the rendered message.
    Encrypted,
    /// The payload is rendered into the message body the recipient's model reads.
    Plaintext,
}

impl InterAgentPayloadFormat {
    /// Chooses a carrier the recipient's model can actually read.
    ///
    /// `encrypted_content` items only survive the round trip on the OpenAI Responses API;
    /// [`ModelClient`](crate::client::ModelClient) clears encrypted function args for every
    /// other provider. A third-party recipient therefore receives a task whose body is
    /// empty and answers as though nothing had been assigned, so those providers get the
    /// payload spelled out in the message instead.
    pub(crate) fn for_turn(
        source: &ToolCallSource,
        turn: &crate::session::turn_context::TurnContext,
    ) -> Self {
        match source {
            ToolCallSource::DirectPlaintextMessage => Self::Plaintext,
            ToolCallSource::Direct | ToolCallSource::CodeMode { .. } => {
                if turn.provider.info().is_openai() {
                    Self::Encrypted
                } else {
                    Self::Plaintext
                }
            }
        }
    }
}

fn communication_from_tool_message(
    author: AgentPath,
    recipient: AgentPath,
    message: String,
    format: InterAgentPayloadFormat,
    trigger_turn: bool,
) -> InterAgentCommunication {
    match format {
        InterAgentPayloadFormat::Encrypted => InterAgentCommunication::new_encrypted(
            author,
            recipient,
            Vec::new(),
            message,
            trigger_turn,
        ),
        InterAgentPayloadFormat::Plaintext => {
            let message_type = if trigger_turn {
                InterAgentMessageType::NewTask
            } else {
                InterAgentMessageType::Message
            };
            let content =
                InterAgentMessage::new(message_type, recipient.clone(), author.clone(), message)
                    .render();
            InterAgentCommunication::new(author, recipient, Vec::new(), content, trigger_turn)
        }
    }
}
