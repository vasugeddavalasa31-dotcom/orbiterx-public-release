use orbiterx_protocol::models::ContentItem;
use orbiterx_protocol::models::ResponseItem;
use orbiterx_tools::ToolSpec;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use serde_json::json;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnthropicMessage {
    pub role: String,
    pub content: Vec<AnthropicContent>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AnthropicContent {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: JsonValue,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
    },
}

#[derive(Debug, Serialize, Clone)]
pub struct AnthropicTool {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
}

/// Translates OrbiterX ToolSpec entries to Anthropic's tool format.
/// Handles namespace flattening using a double-underscore prefix (e.g. `namespace__tool`).
pub fn translate_tools_to_anthropic(tools: &[ToolSpec]) -> Vec<AnthropicTool> {
    let mut result = Vec::new();
    for spec in tools {
        match spec {
            ToolSpec::Function(tool) => {
                result.push(AnthropicTool {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    input_schema: serde_json::to_value(&tool.parameters)
                        .unwrap_or(json!({ "type": "object" })),
                });
            }
            ToolSpec::Namespace(ns) => {
                for ns_tool in &ns.tools {
                    match ns_tool {
                        orbiterx_tools::ResponsesApiNamespaceTool::Function(tool) => {
                            result.push(AnthropicTool {
                                name: format!("{}__{}", ns.name, tool.name),
                                description: tool.description.clone(),
                                input_schema: serde_json::to_value(&tool.parameters)
                                    .unwrap_or(json!({ "type": "object" })),
                            });
                        }
                    }
                }
            }
            ToolSpec::Freeform(tool) => {
                result.push(AnthropicTool {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    input_schema: json!({ "type": "object" }),
                });
            }
            _ => {}
        }
    }
    result
}

/// Translates a vector of OrbiterX ResponseItems into a vector of AnthropicMessages.
/// It merges consecutive assistant tool calls or user tool results into single messages to comply with Anthropic specs.
pub fn translate_history_to_anthropic(items: &[ResponseItem]) -> Vec<AnthropicMessage> {
    let mut messages: Vec<AnthropicMessage> = Vec::new();

    for item in items {
        match item {
            ResponseItem::Message { role, content, .. } => {
                let mapped_role = if role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                let mut content_blocks = Vec::new();
                for content_item in content {
                    match content_item {
                        ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                            content_blocks.push(AnthropicContent::Text { text: text.clone() });
                        }
                        _ => {}
                    }
                }
                if !content_blocks.is_empty() {
                    append_or_merge_message(&mut messages, mapped_role, content_blocks);
                }
            }
            ResponseItem::FunctionCall {
                name,
                namespace,
                arguments,
                call_id,
                ..
            } => {
                let final_name = match namespace {
                    Some(ns) => format!("{ns}__{name}"),
                    None => name.clone(),
                };
                let input = serde_json::from_str(arguments).unwrap_or(json!({}));
                let content_block = AnthropicContent::ToolUse {
                    id: call_id.clone(),
                    name: final_name,
                    input,
                };
                append_or_merge_message(&mut messages, "assistant", vec![content_block]);
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            } => {
                let text = output.body.to_text().unwrap_or_default();
                let content_block = AnthropicContent::ToolResult {
                    tool_use_id: call_id.clone(),
                    content: text,
                };
                append_or_merge_message(&mut messages, "user", vec![content_block]);
            }
            _ => {}
        }
    }

    messages
}

fn append_or_merge_message(
    messages: &mut Vec<AnthropicMessage>,
    role: &str,
    mut blocks: Vec<AnthropicContent>,
) {
    if let Some(last) = messages.last_mut()
        && last.role == role
    {
        last.content.append(&mut blocks);
        return;
    }
    messages.push(AnthropicMessage {
        role: role.to_string(),
        content: blocks,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbiterx_protocol::models::ContentItem;
    use orbiterx_protocol::models::ResponseItem;

    #[test]
    fn test_translate_history_to_anthropic() {
        let items = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "Hello".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: "World".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
        ];

        let result = translate_history_to_anthropic(&items);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].role, "user");
        assert_eq!(
            result[0].content[0],
            AnthropicContent::Text {
                text: "Hello".to_string()
            }
        );
        assert_eq!(result[1].role, "assistant");
        assert_eq!(
            result[1].content[0],
            AnthropicContent::Text {
                text: "World".to_string()
            }
        );
    }
}
