use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence;
use app_test_support::to_response;
use core_test_support::responses;
use core_test_support::skip_if_no_network;
use core_test_support::skip_if_wine_exec;
use orbiterx_app_server_protocol::CommandExecutionStatus;
use orbiterx_app_server_protocol::JSONRPCResponse;
use orbiterx_app_server_protocol::RequestId;
use orbiterx_app_server_protocol::SandboxPolicy;
use orbiterx_app_server_protocol::ThreadItem;
use orbiterx_app_server_protocol::ThreadReadParams;
use orbiterx_app_server_protocol::ThreadReadResponse;
use orbiterx_app_server_protocol::ThreadStartParams;
use orbiterx_app_server_protocol::ThreadStartResponse;
use orbiterx_app_server_protocol::TurnStartParams;
use orbiterx_app_server_protocol::TurnStartResponse;
use orbiterx_app_server_protocol::UserInput as V2UserInput;
use orbiterx_features::FEATURES;
use orbiterx_features::Feature;
use pretty_assertions::assert_eq;
use std::collections::BTreeMap;
use std::path::Path;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// A turn that streams reasoning, runs a shell command, and ends with an agent
/// message must reconstruct the SAME item sequence from `thread/read` that the
/// live `item/*` notifications emitted — this is the contract the frontend
/// relies on for a restored session to look identical to the live session.
#[tokio::test]
async fn thread_read_reconstructs_reasoning_command_and_agent_message_items() -> Result<()> {
    // The command executes on the app-server host (auto_env) and needs a
    // Windows-compatible argv, mirroring command_execution_notifications_include_process_id.
    skip_if_wine_exec!(
        Ok(()),
        "process id reporting differs for a Windows executor"
    );
    skip_if_no_network!(Ok(()));

    let (cmd, args) = if cfg!(windows) {
        ("cmd.exe", vec!["/d", "/c", "echo hi"])
    } else {
        ("/bin/sh", vec!["-c", "echo hi"])
    };
    let command_argv = std::iter::once(cmd.to_string())
        .chain(args.into_iter().map(str::to_string))
        .collect::<Vec<_>>();
    let exec_args = serde_json::to_string(&serde_json::json!({
        "cmd": command_argv.join(" "),
        "yield_time_ms": 500
    }))?;

    // Response 1: reasoning (summary + raw content), then the model runs
    // `exec_command`. Response 2: the final agent message.
    let responses = vec![
        responses::sse(vec![
            responses::ev_response_created("resp-1"),
            responses::ev_reasoning_item(
                "reason-1",
                &["Let me inspect the file."],
                &["step one", "step two"],
            ),
            responses::ev_function_call("exec-1", "exec_command", &exec_args),
            responses::ev_completed("resp-1"),
        ]),
        create_final_assistant_message_sse_response("Here are the summaries.")?,
    ];
    let server = create_mock_responses_server_sequence(responses).await;
    let orbiterx_home = TempDir::new()?;
    create_config_toml_with_sandbox(
        orbiterx_home.path(),
        &server.uri(),
        "never",
        &BTreeMap::from([(Feature::UnifiedExec, true)]),
        "danger-full-access",
    )?;

    let mut mcp = TestAppServer::builder()
        .with_orbiterx_home(orbiterx_home.path())
        .build()
        .await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let start_id = mcp
        .send_thread_start_request_with_auto_env(ThreadStartParams {
            model: Some("mock-model".to_string()),
            ..Default::default()
        })
        .await?;
    let start_resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(start_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(start_resp)?;

    let turn_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id.clone(),
            client_user_message_id: None,
            input: vec![V2UserInput::Text {
                text: "read the file".to_string(),
                text_elements: Vec::new(),
            }],
            sandbox_policy: Some(SandboxPolicy::DangerFullAccess),
            ..Default::default()
        })
        .await?;
    let turn_resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_id)),
    )
    .await??;
    let TurnStartResponse { turn: _turn } = to_response::<TurnStartResponse>(turn_resp)?;

    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;

    let read_id = mcp
        .send_thread_read_request(ThreadReadParams {
            thread_id: thread.id,
            include_turns: true,
        })
        .await?;
    let read_resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(read_id)),
    )
    .await??;
    let ThreadReadResponse { thread, .. } = to_response::<ThreadReadResponse>(read_resp)?;
    assert_eq!(thread.turns.len(), 1);
    let items = &thread.turns[0].items;

    // Reconstructed order must mirror the live stream: user message →
    // reasoning → command execution → agent message.
    let mut kinds = Vec::new();
    let mut reasoning: Option<(Vec<String>, Vec<String>)> = None;
    let mut command: Option<(String, CommandExecutionStatus)> = None;
    let mut agent_message: Option<String> = None;
    for item in items {
        match item {
            ThreadItem::UserMessage { .. } => kinds.push("user"),
            ThreadItem::Reasoning {
                summary, content, ..
            } => {
                kinds.push("reasoning");
                reasoning = Some((summary.clone(), content.clone()));
            }
            ThreadItem::CommandExecution {
                command: cmd,
                status,
                ..
            } => {
                kinds.push("command");
                command = Some((cmd.clone(), status.clone()));
            }
            ThreadItem::AgentMessage { text, .. } => {
                kinds.push("agent_message");
                agent_message = Some(text.clone());
            }
            _ => kinds.push("other"),
        }
    }
    assert_eq!(
        kinds,
        vec!["user", "reasoning", "command", "agent_message"],
        "reconstructed item order should match the live item order"
    );

    // Reasoning must keep BOTH its summary and raw content — the frontend joins
    // them so a restored thinking block matches the live one.
    let (summary, content) = reasoning.expect("reasoning item should be reconstructed");
    assert_eq!(summary, vec!["Let me inspect the file."]);
    assert_eq!(content, vec!["step one", "step two"]);

    let (command_text, status) = command.expect("command execution item should be reconstructed");
    assert_eq!(command_text, command_argv.join(" "));
    assert_eq!(status, CommandExecutionStatus::Completed);

    let message = agent_message.expect("agent message should be reconstructed");
    assert_eq!(message, "Here are the summaries.");

    Ok(())
}

fn create_config_toml_with_sandbox(
    orbiterx_home: &Path,
    server_uri: &str,
    approval_policy: &str,
    feature_flags: &BTreeMap<Feature, bool>,
    sandbox_mode: &str,
) -> std::io::Result<()> {
    let mut features = BTreeMap::new();
    for (feature, enabled) in feature_flags {
        features.insert(*feature, *enabled);
    }
    let feature_entries = features
        .into_iter()
        .map(|(feature, enabled)| {
            let key = FEATURES
                .iter()
                .find(|spec| spec.id == feature)
                .map(|spec| spec.key)
                .expect("feature should have a config key");
            format!("{key} = {enabled}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let config_toml = orbiterx_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "{approval_policy}"
sandbox_mode = "{sandbox_mode}"

model_provider = "mock_provider"

[features]
{feature_entries}

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
        ),
    )
}
