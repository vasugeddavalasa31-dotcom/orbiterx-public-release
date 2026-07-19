use orbiterx_core::NewThread;
use orbiterx_core::OrbiterXThread;
use orbiterx_core::StartThreadOptions;
use orbiterx_core::ThreadManager;
use orbiterx_core::config::Config;
use orbiterx_protocol::ThreadId;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::error::Result as OrbiterXResult;
use orbiterx_protocol::protocol::InitialHistory;
use orbiterx_protocol::protocol::W3cTraceContext;
use orbiterx_protocol::user_input::UserInput;
use std::sync::Arc;
use std::sync::Weak;

/// A fully resolved agent invocation.
///
/// Agent discovery owns rendering `prompt`, including any selected skill
/// references. The runtime only starts that prompt in isolated forked context.
pub struct AgentInvocation {
    pub config: Config,
    pub prompt: String,
    pub parent_trace: Option<W3cTraceContext>,
}

/// A spawned agent whose initial turn has been submitted.
pub struct AgentRun {
    pub thread_id: ThreadId,
    pub turn_id: String,
    pub thread: Arc<OrbiterXThread>,
}

/// Runs resolved agents in threads forked by the owning [`ThreadManager`].
#[derive(Clone)]
pub struct AgentRunner {
    thread_manager: Weak<ThreadManager>,
}

impl AgentRunner {
    pub fn new(thread_manager: Weak<ThreadManager>) -> Self {
        Self { thread_manager }
    }

    /// Starts a resolved agent in a fork of `parent_thread_id`.
    pub async fn start(
        &self,
        parent_thread_id: ThreadId,
        invocation: AgentInvocation,
    ) -> OrbiterXResult<AgentRun> {
        let AgentInvocation {
            config,
            prompt,
            parent_trace,
        } = invocation;
        if prompt.trim().is_empty() {
            return Err(OrbiterXErr::InvalidRequest(
                "agent prompt must not be empty".to_string(),
            ));
        }

        let thread_manager = self.thread_manager.upgrade().ok_or_else(|| {
            OrbiterXErr::UnsupportedOperation("thread manager dropped".to_string())
        })?;
        let environments =
            thread_manager.default_environment_selections(&config.cwd, &config.workspace_roots);
        let NewThread {
            thread_id, thread, ..
        } = thread_manager
            .spawn_subagent(
                parent_thread_id,
                StartThreadOptions {
                    config,
                    allow_provider_model_fallback: false,
                    initial_history: InitialHistory::New,
                    history_mode: None,
                    session_source: None,
                    thread_source: None,
                    dynamic_tools: Vec::new(),
                    metrics_service_name: None,
                    parent_trace: parent_trace.clone(),
                    environments,
                    thread_extension_init: Default::default(),
                    supports_openai_form_elicitation: false,
                },
            )
            .await?;
        let turn_id = thread
            .submit_with_trace(
                vec![UserInput::Text {
                    text: prompt,
                    text_elements: Vec::new(),
                }]
                .into(),
                parent_trace,
            )
            .await?;

        Ok(AgentRun {
            thread_id,
            turn_id,
            thread,
        })
    }
}
