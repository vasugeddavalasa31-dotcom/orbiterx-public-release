use crate::events::AppServerRpcTransport;
use crate::events::GuardianReviewEventParams;
use crate::events::OrbiterXRuntimeMetadata;
use orbiterx_app_server_protocol::ClientRequest;
use orbiterx_app_server_protocol::ClientResponsePayload;
use orbiterx_app_server_protocol::InitializeParams;
use orbiterx_app_server_protocol::JSONRPCErrorError;
use orbiterx_app_server_protocol::RequestId;
use orbiterx_app_server_protocol::ServerNotification;
use orbiterx_app_server_protocol::ServerRequest;
use orbiterx_app_server_protocol::ServerResponse;
use orbiterx_plugin::PluginTelemetryMetadata;
use orbiterx_protocol::config_types::ApprovalsReviewer;
use orbiterx_protocol::config_types::ModeKind;
use orbiterx_protocol::config_types::Personality;
use orbiterx_protocol::config_types::ReasoningSummary;
use orbiterx_protocol::config_types::ServiceTier;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::models::PermissionProfile;
use orbiterx_protocol::openai_models::ReasoningEffort;
use orbiterx_protocol::protocol::AskForApproval;
use orbiterx_protocol::protocol::HookEventName;
use orbiterx_protocol::protocol::HookRunStatus;
use orbiterx_protocol::protocol::HookSource;
use orbiterx_protocol::protocol::SessionSource;
use orbiterx_protocol::protocol::SkillScope;
use orbiterx_protocol::protocol::SubAgentSource;
use orbiterx_protocol::protocol::TokenUsage;
use orbiterx_protocol::request_permissions::RequestPermissionsResponse;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AcceptedLineFingerprint {
    pub path_hash: String,
    pub line_hash: String,
}

#[derive(Clone)]
pub struct TrackEventsContext {
    pub model_slug: String,
    pub thread_id: String,
    pub turn_id: String,
    pub product_client_id: String,
}

pub fn build_track_events_context(
    model_slug: String,
    thread_id: String,
    turn_id: String,
    product_client_id: String,
) -> TrackEventsContext {
    TrackEventsContext {
        model_slug,
        thread_id,
        turn_id,
        product_client_id,
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSubmissionType {
    Default,
    Queued,
}

#[derive(Clone)]
pub struct TurnResolvedConfigFact {
    pub turn_id: String,
    pub thread_id: String,
    pub num_input_images: usize,
    pub submission_type: Option<TurnSubmissionType>,
    pub ephemeral: bool,
    pub session_source: SessionSource,
    pub model: String,
    pub model_provider: String,
    pub permission_profile: PermissionProfile,
    pub permission_profile_cwd: PathBuf,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub reasoning_summary: Option<ReasoningSummary>,
    pub service_tier: Option<ServiceTier>,
    pub approval_policy: AskForApproval,
    pub approvals_reviewer: ApprovalsReviewer,
    pub sandbox_network_access: bool,
    pub collaboration_mode: ModeKind,
    pub personality: Option<Personality>,
    pub workspace_kind: Option<String>,
    pub is_first_turn: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadInitializationMode {
    New,
    Forked,
    Resumed,
}

#[derive(Clone)]
pub struct TurnTokenUsageFact {
    pub turn_id: String,
    pub thread_id: String,
    pub token_usage: TokenUsage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TurnProfile {
    pub before_first_sampling_ms: u64,
    pub sampling_ms: u64,
    pub between_sampling_overhead_ms: u64,
    pub tool_blocking_ms: u64,
    pub after_last_sampling_ms: u64,
    pub sampling_request_count: u32,
    pub sampling_retry_count: u32,
}

#[derive(Clone)]
pub struct TurnProfileFact {
    pub turn_id: String,
    pub profile: TurnProfile,
}

#[derive(Clone)]
pub struct TurnOrbiterXErrorFact {
    pub(crate) turn_id: String,
    pub(crate) thread_id: String,
    pub(crate) error: TurnOrbiterXError,
}

impl TurnOrbiterXErrorFact {
    pub fn from_orbiterx_err(thread_id: String, turn_id: String, error: &OrbiterXErr) -> Self {
        Self {
            turn_id,
            thread_id,
            error: TurnOrbiterXError::from_orbiterx_err(error),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbiterXErrKind {
    TurnAborted,
    SessionBudgetExceeded,
    Stream,
    ContextWindowExceeded,
    ThreadNotFound,
    AgentLimitReached,
    SessionConfiguredNotFirstEvent,
    Timeout,
    RequestTimeout,
    Spawn,
    Interrupted,
    UnexpectedStatus,
    InvalidRequest,
    InvalidImageRequest,
    UsageLimitReached,
    ServerOverloaded,
    CyberPolicy,
    ResponseStreamFailed,
    ConnectionFailed,
    QuotaExceeded,
    UsageNotIncluded,
    InternalServerError,
    RetryLimit,
    InternalAgentDied,
    Sandbox,
    LandlockSandboxExecutableNotProvided,
    UnsupportedOperation,
    RefreshTokenFailed,
    Fatal,
    Io,
    Json,
    #[cfg(target_os = "linux")]
    LandlockRuleset,
    #[cfg(target_os = "linux")]
    LandlockPathFd,
    TokioJoin,
    EnvVar,
}

#[derive(Clone)]
pub(crate) struct TurnOrbiterXError {
    pub(crate) kind: OrbiterXErrKind,
    pub(crate) http_status_code: Option<u16>,
}

impl TurnOrbiterXError {
    fn from_orbiterx_err(error: &OrbiterXErr) -> Self {
        Self {
            kind: error.into(),
            http_status_code: error.http_status_code_value(),
        }
    }
}

impl From<&OrbiterXErr> for OrbiterXErrKind {
    fn from(error: &OrbiterXErr) -> Self {
        match error {
            OrbiterXErr::TurnAborted => OrbiterXErrKind::TurnAborted,
            OrbiterXErr::SessionBudgetExceeded => OrbiterXErrKind::SessionBudgetExceeded,
            OrbiterXErr::Stream(..) => OrbiterXErrKind::Stream,
            OrbiterXErr::ContextWindowExceeded => OrbiterXErrKind::ContextWindowExceeded,
            OrbiterXErr::ThreadNotFound(_) => OrbiterXErrKind::ThreadNotFound,
            OrbiterXErr::AgentLimitReached { .. } => OrbiterXErrKind::AgentLimitReached,
            OrbiterXErr::SessionConfiguredNotFirstEvent => {
                OrbiterXErrKind::SessionConfiguredNotFirstEvent
            }
            OrbiterXErr::Timeout => OrbiterXErrKind::Timeout,
            OrbiterXErr::RequestTimeout => OrbiterXErrKind::RequestTimeout,
            OrbiterXErr::Spawn => OrbiterXErrKind::Spawn,
            OrbiterXErr::Interrupted => OrbiterXErrKind::Interrupted,
            OrbiterXErr::UnexpectedStatus(_) => OrbiterXErrKind::UnexpectedStatus,
            OrbiterXErr::InvalidRequest(_) => OrbiterXErrKind::InvalidRequest,
            OrbiterXErr::InvalidImageRequest() => OrbiterXErrKind::InvalidImageRequest,
            OrbiterXErr::UsageLimitReached(_) => OrbiterXErrKind::UsageLimitReached,
            OrbiterXErr::ServerOverloaded => OrbiterXErrKind::ServerOverloaded,
            OrbiterXErr::CyberPolicy { .. } => OrbiterXErrKind::CyberPolicy,
            OrbiterXErr::ResponseStreamFailed(_) => OrbiterXErrKind::ResponseStreamFailed,
            OrbiterXErr::ConnectionFailed(_) => OrbiterXErrKind::ConnectionFailed,
            OrbiterXErr::QuotaExceeded => OrbiterXErrKind::QuotaExceeded,
            OrbiterXErr::UsageNotIncluded => OrbiterXErrKind::UsageNotIncluded,
            OrbiterXErr::InternalServerError => OrbiterXErrKind::InternalServerError,
            OrbiterXErr::RetryLimit(_) => OrbiterXErrKind::RetryLimit,
            OrbiterXErr::InternalAgentDied => OrbiterXErrKind::InternalAgentDied,
            OrbiterXErr::Sandbox(_) => OrbiterXErrKind::Sandbox,
            OrbiterXErr::LandlockSandboxExecutableNotProvided => {
                OrbiterXErrKind::LandlockSandboxExecutableNotProvided
            }
            OrbiterXErr::UnsupportedOperation(_) => OrbiterXErrKind::UnsupportedOperation,
            OrbiterXErr::RefreshTokenFailed(_) => OrbiterXErrKind::RefreshTokenFailed,
            OrbiterXErr::Fatal(_) => OrbiterXErrKind::Fatal,
            OrbiterXErr::Io(_) => OrbiterXErrKind::Io,
            OrbiterXErr::Json(_) => OrbiterXErrKind::Json,
            #[cfg(target_os = "linux")]
            OrbiterXErr::LandlockRuleset(_) => OrbiterXErrKind::LandlockRuleset,
            #[cfg(target_os = "linux")]
            OrbiterXErr::LandlockPathFd(_) => OrbiterXErrKind::LandlockPathFd,
            OrbiterXErr::TokioJoin(_) => OrbiterXErrKind::TokioJoin,
            OrbiterXErr::EnvVar(_) => OrbiterXErrKind::EnvVar,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSteerResult {
    Accepted,
    Rejected,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSteerRejectionReason {
    NoActiveTurn,
    ExpectedTurnMismatch,
    NonSteerableReview,
    NonSteerableCompact,
    EmptyInput,
    InputTooLarge,
}

#[derive(Clone)]
pub struct OrbiterXTurnSteerEvent {
    pub expected_turn_id: Option<String>,
    pub accepted_turn_id: Option<String>,
    pub num_input_images: usize,
    pub result: TurnSteerResult,
    pub rejection_reason: Option<TurnSteerRejectionReason>,
    pub created_at: u64,
}

#[derive(Clone, Copy, Debug)]
pub enum AnalyticsJsonRpcError {
    TurnSteer(TurnSteerRequestError),
    Input(InputError),
}

#[derive(Clone, Copy, Debug)]
pub enum TurnSteerRequestError {
    NoActiveTurn,
    ExpectedTurnMismatch,
    NonSteerableReview,
    NonSteerableCompact,
}

#[derive(Clone, Copy, Debug)]
pub enum InputError {
    Empty,
    TooLarge,
}

impl From<TurnSteerRequestError> for TurnSteerRejectionReason {
    fn from(error: TurnSteerRequestError) -> Self {
        match error {
            TurnSteerRequestError::NoActiveTurn => Self::NoActiveTurn,
            TurnSteerRequestError::ExpectedTurnMismatch => Self::ExpectedTurnMismatch,
            TurnSteerRequestError::NonSteerableReview => Self::NonSteerableReview,
            TurnSteerRequestError::NonSteerableCompact => Self::NonSteerableCompact,
        }
    }
}

impl From<InputError> for TurnSteerRejectionReason {
    fn from(error: InputError) -> Self {
        match error {
            InputError::Empty => Self::EmptyInput,
            InputError::TooLarge => Self::InputTooLarge,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SkillInvocation {
    pub skill_name: String,
    pub skill_scope: SkillScope,
    pub skill_path: PathBuf,
    pub plugin_id: Option<String>,
    pub invocation_type: InvocationType,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InvocationType {
    Explicit,
    Implicit,
}

pub struct AppInvocation {
    pub connector_id: Option<String>,
    pub app_name: Option<String>,
    pub invocation_type: Option<InvocationType>,
}

#[derive(Clone)]
pub struct SubAgentThreadStartedInput {
    pub session_id: String,
    pub thread_id: String,
    pub parent_thread_id: Option<String>,
    pub forked_from_thread_id: Option<String>,
    pub product_client_id: String,
    pub client_name: String,
    pub client_version: String,
    pub model: String,
    pub ephemeral: bool,
    pub subagent_source: SubAgentSource,
    pub created_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionTrigger {
    Manual,
    Auto,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    UserRequested,
    ContextLimit,
    ModelDownshift,
    CompHashChanged,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionImplementation {
    Responses,
    ResponsesCompactionV2,
    ResponsesCompact,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionPhase {
    StandaloneTurn,
    PreTurn,
    MidTurn,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStrategy {
    Memento,
    PrefixCompaction,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone)]
pub struct OrbiterXCompactionEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub trigger: CompactionTrigger,
    pub reason: CompactionReason,
    pub implementation: CompactionImplementation,
    pub phase: CompactionPhase,
    pub strategy: CompactionStrategy,
    pub status: CompactionStatus,
    pub orbiterx_error_kind: Option<OrbiterXErrKind>,
    pub orbiterx_error_http_status_code: Option<u16>,
    pub active_context_tokens_before: i64,
    pub active_context_tokens_after: i64,
    pub retained_image_count: Option<usize>,
    pub compaction_summary_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub cache_write_input_tokens: Option<i64>,
    pub started_at: u64,
    pub completed_at: u64,
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalEventKind {
    Created,
    UsageAccounted,
    StatusChanged,
    Cleared,
}

#[derive(Clone)]
pub struct OrbiterXGoalEvent {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub goal_id: String,
    pub event_kind: GoalEventKind,
    pub goal_status: orbiterx_state::ThreadGoalStatus,
    pub has_token_budget: bool,
    pub cumulative_tokens_accounted: Option<i64>,
    pub cumulative_time_accounted_seconds: Option<i64>,
}

#[allow(dead_code)]
pub(crate) enum AnalyticsFact {
    Initialize {
        connection_id: u64,
        params: InitializeParams,
        product_client_id: String,
        runtime: OrbiterXRuntimeMetadata,
        rpc_transport: AppServerRpcTransport,
    },
    ClientRequest {
        connection_id: u64,
        request_id: RequestId,
        request: Box<ClientRequest>,
    },
    ClientResponse {
        connection_id: u64,
        request_id: RequestId,
        response: Box<ClientResponsePayload>,
        thread_originator: Option<String>,
    },
    ErrorResponse {
        connection_id: u64,
        request_id: RequestId,
        error: JSONRPCErrorError,
        error_type: Option<AnalyticsJsonRpcError>,
    },
    ServerRequest {
        connection_id: u64,
        request: Box<ServerRequest>,
    },
    ServerResponse {
        completed_at_ms: u64,
        response: Box<ServerResponse>,
    },
    EffectivePermissionsApprovalResponse {
        completed_at_ms: u64,
        request_id: RequestId,
        response: Box<RequestPermissionsResponse>,
    },
    ServerRequestAborted {
        completed_at_ms: u64,
        request_id: RequestId,
    },
    Notification(Box<ServerNotification>),
    // Facts that do not naturally exist on the app-server protocol surface, or
    // would require non-trivial protocol reshaping on this branch.
    Custom(CustomAnalyticsFact),
}

pub(crate) enum CustomAnalyticsFact {
    SubAgentThreadStarted(SubAgentThreadStartedInput),
    Compaction(Box<OrbiterXCompactionEvent>),
    Goal(Box<OrbiterXGoalEvent>),
    GuardianReview(Box<GuardianReviewEventParams>),
    TurnResolvedConfig(Box<TurnResolvedConfigFact>),
    TurnTokenUsage(Box<TurnTokenUsageFact>),
    TurnProfile(Box<TurnProfileFact>),
    TurnOrbiterXError(Box<TurnOrbiterXErrorFact>),
    SkillInvoked(SkillInvokedInput),
    AppMentioned(AppMentionedInput),
    AppUsed(AppUsedInput),
    HookRun(HookRunInput),
    PluginUsed(PluginUsedInput),
    PluginInstallRequested(PluginInstallRequestedInput),
    PluginStateChanged(PluginStateChangedInput),
    PluginInstallFailed(PluginInstallFailedInput),
    ExternalAgentConfigImportCompleted(ExternalAgentConfigImportCompletedInput),
    ExternalAgentConfigImportFailure(ExternalAgentConfigImportFailureInput),
}

pub(crate) struct SkillInvokedInput {
    pub tracking: TrackEventsContext,
    pub invocations: Vec<SkillInvocation>,
}

pub(crate) struct AppMentionedInput {
    pub tracking: TrackEventsContext,
    pub mentions: Vec<AppInvocation>,
}

pub(crate) struct AppUsedInput {
    pub tracking: TrackEventsContext,
    pub app: AppInvocation,
}

pub(crate) struct HookRunInput {
    pub tracking: TrackEventsContext,
    pub hook: HookRunFact,
}

pub struct HookRunFact {
    pub event_name: HookEventName,
    pub hook_source: HookSource,
    pub status: HookRunStatus,
}

pub(crate) struct PluginUsedInput {
    pub tracking: TrackEventsContext,
    pub plugin: PluginTelemetryMetadata,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallRequestSource {
    EndpointRecommendation,
    LegacyDiscovery,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginInstallRequested {
    pub suggestion_id: String,
    pub plugins: Vec<PluginInstallRequestedPlugin>,
    pub source: PluginInstallRequestSource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginInstallRequestedPlugin {
    pub plugin_id: String,
    pub remote_plugin_id: Option<String>,
    pub plugin_name: String,
    pub connector_ids: Vec<String>,
}

pub(crate) struct PluginInstallRequestedInput {
    pub tracking: TrackEventsContext,
    pub request: PluginInstallRequested,
}

pub(crate) struct PluginStateChangedInput {
    pub plugin: PluginTelemetryMetadata,
    pub state: PluginState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallSource {
    Manual,
    ExternalAgentMigration,
}

pub(crate) struct PluginInstallFailedInput {
    pub plugin: PluginTelemetryMetadata,
    pub source: PluginInstallSource,
    pub error_type: String,
    pub sub_error_type: Option<String>,
}

pub struct ExternalAgentConfigImportCompletedInput {
    pub import_id: String,
    pub source: String,
    pub item_type: String,
    pub success_count: usize,
    pub failed_count: usize,
}

pub struct ExternalAgentConfigImportFailureInput {
    pub import_id: String,
    pub source: String,
    pub item_type: String,
    pub failure_stage: String,
    pub error_type: String,
    pub sub_error_type: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) enum PluginState {
    Installed,
    Uninstalled,
    Enabled,
    Disabled,
}
