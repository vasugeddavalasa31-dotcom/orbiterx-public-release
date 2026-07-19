use crate::function_tool::FunctionCallError;
use crate::tools::context::FunctionToolOutput;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::context::boxed_tool_output;
use crate::tools::registry::CoreToolRuntime;
use crate::tools::registry::ToolExecutor;
use orbiterx_protocol::models::ResponseInputItem;
use orbiterx_tools::JsonSchema;
use orbiterx_tools::ResponsesApiNamespace;
use orbiterx_tools::ResponsesApiNamespaceTool;
use orbiterx_tools::ResponsesApiTool;
use orbiterx_tools::ToolName;
use orbiterx_tools::ToolSpec;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use serde_json::json;
use std::collections::BTreeMap;
use tokio::fs;

const NAMESPACE: &str = "fs";
const TOOL_NAME: &str = "list_directory";

#[derive(Deserialize)]
struct ListDirectoryArgs {
    path: String,
}

struct ListDirectoryOutput {
    entries: Vec<String>,
}

impl ToolOutput for ListDirectoryOutput {
    fn log_preview(&self) -> String {
        format!("Listed {} entries", self.entries.len())
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        let json_text = serde_json::to_string(&json!({ "entries": self.entries })).unwrap();
        FunctionToolOutput::from_text(json_text, Some(true)).to_response_item(call_id, payload)
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        json!({
            "entries": self.entries,
        })
    }
}

pub struct ListDirectoryHandler;

impl ToolExecutor<ToolInvocation> for ListDirectoryHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced(NAMESPACE, TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::Namespace(ResponsesApiNamespace {
            name: NAMESPACE.to_string(),
            description: "Tools for file system operations.".to_string(),
            tools: vec![ResponsesApiNamespaceTool::Function(ResponsesApiTool {
                name: TOOL_NAME.to_string(),
                description: "List the contents of a directory.".to_string(),
                strict: false,
                defer_loading: None,
                parameters: JsonSchema::object(
                    BTreeMap::from([(
                        "path".to_string(),
                        JsonSchema::string(Some(
                            "The absolute or relative path to list".to_string(),
                        )),
                    )]),
                    Some(vec!["path".to_string()]),
                    Some(false.into()),
                ),
                output_schema: Some(json!({
                    "type": "object",
                    "properties": {
                        "entries": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "List of file/directory names in the specified path."
                        }
                    },
                    "required": ["entries"],
                    "additionalProperties": false
                })),
            })],
        })
    }

    fn handle(&self, invocation: ToolInvocation) -> orbiterx_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            let ToolPayload::Function { arguments, .. } = &invocation.payload else {
                return Err(FunctionCallError::RespondToModel(format!(
                    "{TOOL_NAME} handler received unsupported payload"
                )));
            };

            let args: ListDirectoryArgs = serde_json::from_str(arguments).map_err(|err| {
                FunctionCallError::RespondToModel(format!("failed to parse arguments: {err:#}"))
            })?;

            let mut entries = Vec::new();
            let mut dir = fs::read_dir(&args.path).await.map_err(|err| {
                FunctionCallError::RespondToModel(format!(
                    "failed to read directory '{}': {err:#}",
                    args.path
                ))
            })?;

            while let Some(entry) = dir.next_entry().await.map_err(|err| {
                FunctionCallError::RespondToModel(format!(
                    "failed to read directory entry: {err:#}"
                ))
            })? {
                if let Ok(name) = entry.file_name().into_string() {
                    entries.push(name);
                }
            }

            Ok(boxed_tool_output(ListDirectoryOutput { entries }))
        })
    }
}

impl CoreToolRuntime for ListDirectoryHandler {}
