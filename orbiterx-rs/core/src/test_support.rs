//! Test-only helpers exposed for cross-crate integration tests.
//!
//! Production code should not depend on this module.
//! We prefer this to using a crate feature to avoid building multiple
//! permutations of the crate.

use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::Lazy;
use orbiterx_exec_server::EnvironmentManager;
use orbiterx_extension_api::LoadUserInstructionsFuture;
use orbiterx_extension_api::LoadedUserInstructions;
use orbiterx_extension_api::UserInstructionsProvider;
use orbiterx_http_client::HttpClientFactory;
use orbiterx_http_client::OutboundProxyPolicy;
use orbiterx_login::AuthManager;
use orbiterx_login::OrbiterXAuth;
use orbiterx_model_provider::create_model_provider;
use orbiterx_model_provider_info::ModelProviderInfo;
use orbiterx_models_manager::bundled_models_response;
use orbiterx_models_manager::collaboration_mode_presets;
use orbiterx_models_manager::manager::SharedModelsManager;
use orbiterx_models_manager::test_support::construct_model_info_offline_for_tests;
use orbiterx_models_manager::test_support::get_model_offline_for_tests;
use orbiterx_protocol::ThreadId;
use orbiterx_protocol::config_types::CollaborationModeMask;
use orbiterx_protocol::openai_models::ModelInfo;
use orbiterx_protocol::openai_models::ModelPreset;
use orbiterx_protocol::protocol::SessionSource;

use crate::ThreadManager;
use crate::config::Config;
use crate::responses_metadata::OrbiterXResponsesMetadata;
use crate::responses_metadata::OrbiterXResponsesRequestKind;
use crate::responses_metadata::subagent_header_value;
use crate::responses_metadata::subagent_metadata_kind;
use crate::thread_manager;
use crate::unified_exec;

static TEST_MODEL_PRESETS: Lazy<Vec<ModelPreset>> = Lazy::new(|| {
    let mut response = bundled_models_response()
        .unwrap_or_else(|err| panic!("bundled models.json should parse: {err}"));
    response.models.sort_by_key(|model| model.priority);
    let mut presets: Vec<ModelPreset> = response.models.into_iter().map(Into::into).collect();
    ModelPreset::mark_default_by_picker_visibility(&mut presets);
    presets
});

/// Test-only provider that supplies no user instructions.
#[derive(Debug, Default)]
pub struct EmptyUserInstructionsProvider;

impl UserInstructionsProvider for EmptyUserInstructionsProvider {
    fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_> {
        Box::pin(async { LoadedUserInstructions::default() })
    }
}

pub fn set_thread_manager_test_mode(enabled: bool) {
    thread_manager::set_thread_manager_test_mode_for_tests(enabled);
}

pub fn set_deterministic_process_ids(enabled: bool) {
    unified_exec::set_deterministic_process_ids_for_tests(enabled);
}

pub fn auth_manager_from_auth(auth: OrbiterXAuth) -> Arc<AuthManager> {
    AuthManager::from_auth_for_testing(auth)
}

pub fn auth_manager_from_auth_with_home(
    auth: OrbiterXAuth,
    orbiterx_home: PathBuf,
) -> Arc<AuthManager> {
    AuthManager::from_auth_for_testing_with_home(auth, orbiterx_home)
}

pub fn with_code_mode_host_program(
    thread_manager: ThreadManager,
    host_program: PathBuf,
) -> ThreadManager {
    thread_manager.with_code_mode_host_program_for_tests(host_program)
}

pub fn thread_manager_with_models_provider(
    auth: OrbiterXAuth,
    provider: ModelProviderInfo,
) -> ThreadManager {
    ThreadManager::with_models_provider_for_tests(auth, provider)
}

pub fn thread_manager_with_models_provider_and_home(
    auth: OrbiterXAuth,
    provider: ModelProviderInfo,
    orbiterx_home: PathBuf,
    environment_manager: Arc<EnvironmentManager>,
) -> ThreadManager {
    ThreadManager::with_models_provider_and_home_for_tests(
        auth,
        provider,
        orbiterx_home,
        environment_manager,
    )
}

pub fn thread_manager_with_models_provider_home_and_state(
    auth: OrbiterXAuth,
    provider: ModelProviderInfo,
    orbiterx_home: PathBuf,
    environment_manager: Arc<EnvironmentManager>,
    state_db: Option<crate::StateDbHandle>,
) -> ThreadManager {
    ThreadManager::with_models_provider_home_and_state_for_tests(
        auth,
        provider,
        orbiterx_home,
        environment_manager,
        state_db,
    )
}

pub async fn start_thread_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    user_shell_override: crate::shell::Shell,
    supports_openai_form_elicitation: bool,
) -> orbiterx_protocol::error::Result<crate::NewThread> {
    thread_manager
        .start_thread_with_user_shell_override_for_tests(
            config,
            user_shell_override,
            supports_openai_form_elicitation,
        )
        .await
}

pub async fn resume_thread_from_rollout_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    rollout_path: PathBuf,
    auth_manager: Arc<AuthManager>,
    user_shell_override: crate::shell::Shell,
    supports_openai_form_elicitation: bool,
) -> orbiterx_protocol::error::Result<crate::NewThread> {
    thread_manager
        .resume_thread_from_rollout_with_user_shell_override_for_tests(
            config,
            rollout_path,
            auth_manager,
            user_shell_override,
            supports_openai_form_elicitation,
        )
        .await
}

pub fn models_manager_with_provider(
    orbiterx_home: PathBuf,
    auth_manager: Arc<AuthManager>,
    provider: ModelProviderInfo,
) -> SharedModelsManager {
    let provider = create_model_provider(provider, Some(auth_manager));
    provider.models_manager(orbiterx_home, /*config_model_catalog*/ None)
}

pub fn default_http_client_factory() -> HttpClientFactory {
    HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault)
}

pub fn get_model_offline(model: Option<&str>) -> String {
    get_model_offline_for_tests(model)
}

pub fn construct_model_info_offline(model: &str, config: &Config) -> ModelInfo {
    construct_model_info_offline_for_tests(model, &config.to_models_manager_config())
}

#[derive(Clone, Copy)]
pub enum TestOrbiterXResponsesRequestKind {
    Turn,
    Prewarm,
    WebsocketConnection,
}

#[allow(clippy::too_many_arguments)]
pub fn responses_metadata(
    installation_id: &str,
    session_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    window_id: String,
    session_source: &SessionSource,
    parent_thread_id: Option<ThreadId>,
    request_kind: TestOrbiterXResponsesRequestKind,
) -> OrbiterXResponsesMetadata {
    let request_kind = match request_kind {
        TestOrbiterXResponsesRequestKind::Turn => Some(OrbiterXResponsesRequestKind::Turn),
        TestOrbiterXResponsesRequestKind::Prewarm => Some(OrbiterXResponsesRequestKind::Prewarm),
        TestOrbiterXResponsesRequestKind::WebsocketConnection => None,
    };
    OrbiterXResponsesMetadata {
        turn_id: request_kind.and(turn_id.map(ToString::to_string)),
        request_kind,
        parent_thread_id,
        subagent_header: subagent_header_value(session_source),
        subagent_kind: request_kind.and_then(|_| subagent_metadata_kind(session_source)),
        ..OrbiterXResponsesMetadata::new(
            installation_id.to_string(),
            session_id.to_string(),
            thread_id.to_string(),
            window_id,
        )
    }
}

pub fn all_model_presets() -> &'static Vec<ModelPreset> {
    &TEST_MODEL_PRESETS
}

pub fn builtin_collaboration_mode_presets() -> Vec<CollaborationModeMask> {
    collaboration_mode_presets::builtin_collaboration_mode_presets()
}
