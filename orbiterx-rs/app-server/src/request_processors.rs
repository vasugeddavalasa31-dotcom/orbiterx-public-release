use crate::bespoke_event_handling::apply_bespoke_event_handling;
use crate::command_exec::CommandExecManager;
use crate::command_exec::StartCommandExecParams;
use crate::config_manager::ConfigManager;
use crate::error_code::INPUT_TOO_LARGE_ERROR_CODE;
use crate::error_code::invalid_params;
use crate::models::supported_models;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::ConnectionRequestId;
use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::RequestContext;
use crate::outgoing_message::ThreadScopedOutgoingMessageSender;
use crate::skills_watcher::SkillsWatcher;
use crate::thread_status::ThreadWatchManager;
use crate::thread_status::resolve_thread_status;
use chrono::Duration as ChronoDuration;
use chrono::SecondsFormat;
use orbiterx_analytics::AnalyticsEventsClient;
use orbiterx_analytics::AnalyticsJsonRpcError;
use orbiterx_analytics::InputError;
use orbiterx_analytics::TurnSteerRequestError;
use orbiterx_app_server_protocol::Account;
use orbiterx_app_server_protocol::AccountLoginCompletedNotification;
use orbiterx_app_server_protocol::AccountTokenUsageDailyBucket;
use orbiterx_app_server_protocol::AccountTokenUsageSummary;
use orbiterx_app_server_protocol::AccountUpdatedNotification;
use orbiterx_app_server_protocol::AddCreditsNudgeCreditType;
use orbiterx_app_server_protocol::AddCreditsNudgeEmailStatus;
use orbiterx_app_server_protocol::AdditionalContextEntry;
use orbiterx_app_server_protocol::AdditionalContextKind;
use orbiterx_app_server_protocol::AppListUpdatedNotification;
use orbiterx_app_server_protocol::AppSummary;
use orbiterx_app_server_protocol::AppTemplateSummary;
use orbiterx_app_server_protocol::AppTemplateUnavailableReason;
use orbiterx_app_server_protocol::AppsInstalledParams;
use orbiterx_app_server_protocol::AppsInstalledResponse;
use orbiterx_app_server_protocol::AppsListParams;
use orbiterx_app_server_protocol::AppsListResponse;
use orbiterx_app_server_protocol::AppsReadParams;
use orbiterx_app_server_protocol::AppsReadResponse;
use orbiterx_app_server_protocol::AskForApproval;
use orbiterx_app_server_protocol::AuthMode;
use orbiterx_app_server_protocol::CancelLoginAccountParams;
use orbiterx_app_server_protocol::CancelLoginAccountResponse;
use orbiterx_app_server_protocol::CancelLoginAccountStatus;
use orbiterx_app_server_protocol::ClientInfo;
use orbiterx_app_server_protocol::ClientRequest;
use orbiterx_app_server_protocol::ClientResponsePayload;
use orbiterx_app_server_protocol::CollaborationModeListParams;
use orbiterx_app_server_protocol::CollaborationModeListResponse;
use orbiterx_app_server_protocol::CommandExecParams;
use orbiterx_app_server_protocol::CommandExecResizeParams;
use orbiterx_app_server_protocol::CommandExecTerminateParams;
use orbiterx_app_server_protocol::CommandExecWriteParams;
use orbiterx_app_server_protocol::ConfigWarningNotification;
use orbiterx_app_server_protocol::ConsumeAccountRateLimitResetCreditOutcome;
use orbiterx_app_server_protocol::ConsumeAccountRateLimitResetCreditParams;
use orbiterx_app_server_protocol::ConsumeAccountRateLimitResetCreditResponse;
use orbiterx_app_server_protocol::ConversationGitInfo;
use orbiterx_app_server_protocol::ConversationSummary;
use orbiterx_app_server_protocol::DeprecationNoticeNotification;
use orbiterx_app_server_protocol::DynamicToolFunctionSpec;
use orbiterx_app_server_protocol::DynamicToolNamespaceTool;
use orbiterx_app_server_protocol::DynamicToolSpec;
use orbiterx_app_server_protocol::EnvironmentAddParams;
use orbiterx_app_server_protocol::EnvironmentAddResponse;
use orbiterx_app_server_protocol::EnvironmentInfoParams;
use orbiterx_app_server_protocol::EnvironmentInfoResponse;
use orbiterx_app_server_protocol::EnvironmentShellInfo;
use orbiterx_app_server_protocol::EnvironmentStatusKind;
use orbiterx_app_server_protocol::EnvironmentStatusParams;
use orbiterx_app_server_protocol::EnvironmentStatusResponse;
use orbiterx_app_server_protocol::ExperimentalFeature as ApiExperimentalFeature;
use orbiterx_app_server_protocol::ExperimentalFeatureListParams;
use orbiterx_app_server_protocol::ExperimentalFeatureListResponse;
use orbiterx_app_server_protocol::ExperimentalFeatureStage as ApiExperimentalFeatureStage;
use orbiterx_app_server_protocol::FeedbackUploadParams;
use orbiterx_app_server_protocol::FeedbackUploadResponse;
use orbiterx_app_server_protocol::GetAccountParams;
use orbiterx_app_server_protocol::GetAccountRateLimitsResponse;
use orbiterx_app_server_protocol::GetAccountResponse;
use orbiterx_app_server_protocol::GetAccountTokenUsageResponse;
use orbiterx_app_server_protocol::GetAuthStatusParams;
use orbiterx_app_server_protocol::GetAuthStatusResponse;
use orbiterx_app_server_protocol::GetConversationSummaryParams;
use orbiterx_app_server_protocol::GetConversationSummaryResponse;
use orbiterx_app_server_protocol::GetWorkspaceMessagesResponse;
use orbiterx_app_server_protocol::GitDiffToRemoteParams;
use orbiterx_app_server_protocol::GitDiffToRemoteResponse;
use orbiterx_app_server_protocol::GitInfo as ApiGitInfo;
use orbiterx_app_server_protocol::HookMetadata;
use orbiterx_app_server_protocol::HooksListParams;
use orbiterx_app_server_protocol::HooksListResponse;
use orbiterx_app_server_protocol::InitializeParams;
use orbiterx_app_server_protocol::InitializeResponse;
use orbiterx_app_server_protocol::InstalledApp;
use orbiterx_app_server_protocol::JSONRPCErrorError;
use orbiterx_app_server_protocol::ListMcpServerStatusParams;
use orbiterx_app_server_protocol::ListMcpServerStatusResponse;
use orbiterx_app_server_protocol::LoginAccountParams;
use orbiterx_app_server_protocol::LoginAccountResponse;
use orbiterx_app_server_protocol::LoginApiKeyParams;
use orbiterx_app_server_protocol::LoginAppBrand;
use orbiterx_app_server_protocol::LogoutAccountResponse;
use orbiterx_app_server_protocol::MarketplaceAddParams;
use orbiterx_app_server_protocol::MarketplaceAddResponse;
use orbiterx_app_server_protocol::MarketplaceInterface;
use orbiterx_app_server_protocol::MarketplaceRemoveParams;
use orbiterx_app_server_protocol::MarketplaceRemoveResponse;
use orbiterx_app_server_protocol::MarketplaceUpgradeErrorInfo;
use orbiterx_app_server_protocol::MarketplaceUpgradeParams;
use orbiterx_app_server_protocol::MarketplaceUpgradeResponse;
use orbiterx_app_server_protocol::McpResourceReadParams;
use orbiterx_app_server_protocol::McpResourceReadResponse;
use orbiterx_app_server_protocol::McpServerOauthLoginCompletedNotification;
use orbiterx_app_server_protocol::McpServerOauthLoginParams;
use orbiterx_app_server_protocol::McpServerOauthLoginResponse;
use orbiterx_app_server_protocol::McpServerRefreshResponse;
use orbiterx_app_server_protocol::McpServerStatus;
use orbiterx_app_server_protocol::McpServerStatusDetail;
use orbiterx_app_server_protocol::McpServerToolCallParams;
use orbiterx_app_server_protocol::McpServerToolCallResponse;
use orbiterx_app_server_protocol::MemoryResetResponse;
use orbiterx_app_server_protocol::MockExperimentalMethodParams;
use orbiterx_app_server_protocol::MockExperimentalMethodResponse;
use orbiterx_app_server_protocol::ModelListParams;
use orbiterx_app_server_protocol::ModelListResponse;
use orbiterx_app_server_protocol::OrbiterXErrorInfo;
use orbiterx_app_server_protocol::PermissionProfileListParams;
use orbiterx_app_server_protocol::PermissionProfileListResponse;
use orbiterx_app_server_protocol::PermissionProfileSummary;
use orbiterx_app_server_protocol::PluginDetail;
use orbiterx_app_server_protocol::PluginInstallParams;
use orbiterx_app_server_protocol::PluginInstallResponse;
use orbiterx_app_server_protocol::PluginInstalledParams;
use orbiterx_app_server_protocol::PluginInstalledResponse;
use orbiterx_app_server_protocol::PluginInterface;
use orbiterx_app_server_protocol::PluginListMarketplaceKind;
use orbiterx_app_server_protocol::PluginListParams;
use orbiterx_app_server_protocol::PluginListResponse;
use orbiterx_app_server_protocol::PluginMarketplaceEntry;
use orbiterx_app_server_protocol::PluginReadParams;
use orbiterx_app_server_protocol::PluginReadResponse;
use orbiterx_app_server_protocol::PluginShareCheckoutParams;
use orbiterx_app_server_protocol::PluginShareCheckoutResponse;
use orbiterx_app_server_protocol::PluginShareContext;
use orbiterx_app_server_protocol::PluginShareDeleteParams;
use orbiterx_app_server_protocol::PluginShareDeleteResponse;
use orbiterx_app_server_protocol::PluginShareDiscoverability;
use orbiterx_app_server_protocol::PluginShareListItem;
use orbiterx_app_server_protocol::PluginShareListParams;
use orbiterx_app_server_protocol::PluginShareListResponse;
use orbiterx_app_server_protocol::PluginSharePrincipal;
use orbiterx_app_server_protocol::PluginSharePrincipalType;
use orbiterx_app_server_protocol::PluginShareSaveParams;
use orbiterx_app_server_protocol::PluginShareSaveResponse;
use orbiterx_app_server_protocol::PluginShareTarget;
use orbiterx_app_server_protocol::PluginShareUpdateDiscoverability;
use orbiterx_app_server_protocol::PluginShareUpdateTargetsParams;
use orbiterx_app_server_protocol::PluginShareUpdateTargetsResponse;
use orbiterx_app_server_protocol::PluginSkillReadParams;
use orbiterx_app_server_protocol::PluginSkillReadResponse;
use orbiterx_app_server_protocol::PluginSource;
use orbiterx_app_server_protocol::PluginSummary;
use orbiterx_app_server_protocol::PluginUninstallParams;
use orbiterx_app_server_protocol::PluginUninstallResponse;
use orbiterx_app_server_protocol::RateLimitResetCredit;
use orbiterx_app_server_protocol::RateLimitResetCreditStatus;
use orbiterx_app_server_protocol::RateLimitResetCreditsSummary;
use orbiterx_app_server_protocol::RateLimitResetType;
use orbiterx_app_server_protocol::RequestId;
use orbiterx_app_server_protocol::ReviewDelivery as ApiReviewDelivery;
use orbiterx_app_server_protocol::ReviewStartParams;
use orbiterx_app_server_protocol::ReviewStartResponse;
use orbiterx_app_server_protocol::ReviewTarget as ApiReviewTarget;
use orbiterx_app_server_protocol::SandboxMode;
use orbiterx_app_server_protocol::SendAddCreditsNudgeEmailParams;
use orbiterx_app_server_protocol::SendAddCreditsNudgeEmailResponse;
use orbiterx_app_server_protocol::ServerNotification;
use orbiterx_app_server_protocol::ServerRequestResolvedNotification;
use orbiterx_app_server_protocol::SkillSummary;
use orbiterx_app_server_protocol::SkillsConfigWriteParams;
use orbiterx_app_server_protocol::SkillsConfigWriteResponse;
use orbiterx_app_server_protocol::SkillsExtraRootsSetParams;
use orbiterx_app_server_protocol::SkillsExtraRootsSetResponse;
use orbiterx_app_server_protocol::SkillsListParams;
use orbiterx_app_server_protocol::SkillsListResponse;
use orbiterx_app_server_protocol::SortDirection;
use orbiterx_app_server_protocol::Thread;
use orbiterx_app_server_protocol::ThreadApproveGuardianDeniedActionParams;
use orbiterx_app_server_protocol::ThreadApproveGuardianDeniedActionResponse;
use orbiterx_app_server_protocol::ThreadArchiveParams;
use orbiterx_app_server_protocol::ThreadArchiveResponse;
use orbiterx_app_server_protocol::ThreadArchivedNotification;
use orbiterx_app_server_protocol::ThreadBackgroundTerminal;
use orbiterx_app_server_protocol::ThreadBackgroundTerminalsCleanParams;
use orbiterx_app_server_protocol::ThreadBackgroundTerminalsCleanResponse;
use orbiterx_app_server_protocol::ThreadBackgroundTerminalsListParams;
use orbiterx_app_server_protocol::ThreadBackgroundTerminalsListResponse;
use orbiterx_app_server_protocol::ThreadBackgroundTerminalsTerminateParams;
use orbiterx_app_server_protocol::ThreadBackgroundTerminalsTerminateResponse;
use orbiterx_app_server_protocol::ThreadClosedNotification;
use orbiterx_app_server_protocol::ThreadCompactStartParams;
use orbiterx_app_server_protocol::ThreadCompactStartResponse;
use orbiterx_app_server_protocol::ThreadDecrementElicitationParams;
use orbiterx_app_server_protocol::ThreadDecrementElicitationResponse;
use orbiterx_app_server_protocol::ThreadDeleteParams;
use orbiterx_app_server_protocol::ThreadDeleteResponse;
use orbiterx_app_server_protocol::ThreadDeletedNotification;
use orbiterx_app_server_protocol::ThreadForkParams;
use orbiterx_app_server_protocol::ThreadForkResponse;
use orbiterx_app_server_protocol::ThreadGoal;
use orbiterx_app_server_protocol::ThreadGoalClearParams;
use orbiterx_app_server_protocol::ThreadGoalClearResponse;
use orbiterx_app_server_protocol::ThreadGoalClearedNotification;
use orbiterx_app_server_protocol::ThreadGoalGetParams;
use orbiterx_app_server_protocol::ThreadGoalGetResponse;
use orbiterx_app_server_protocol::ThreadGoalSetParams;
use orbiterx_app_server_protocol::ThreadGoalSetResponse;
use orbiterx_app_server_protocol::ThreadGoalStatus;
use orbiterx_app_server_protocol::ThreadGoalUpdatedNotification;
use orbiterx_app_server_protocol::ThreadHistoryBuilder;
#[cfg(test)]
use orbiterx_app_server_protocol::ThreadHistoryMode;
use orbiterx_app_server_protocol::ThreadIncrementElicitationParams;
use orbiterx_app_server_protocol::ThreadIncrementElicitationResponse;
use orbiterx_app_server_protocol::ThreadInjectItemsParams;
use orbiterx_app_server_protocol::ThreadInjectItemsResponse;
use orbiterx_app_server_protocol::ThreadItem;
use orbiterx_app_server_protocol::ThreadItemEntry;
use orbiterx_app_server_protocol::ThreadItemsListParams;
use orbiterx_app_server_protocol::ThreadItemsListResponse;
use orbiterx_app_server_protocol::ThreadListCwdFilter;
use orbiterx_app_server_protocol::ThreadListParams;
use orbiterx_app_server_protocol::ThreadListResponse;
use orbiterx_app_server_protocol::ThreadLoadedListParams;
use orbiterx_app_server_protocol::ThreadLoadedListResponse;
use orbiterx_app_server_protocol::ThreadMemoryModeSetParams;
use orbiterx_app_server_protocol::ThreadMemoryModeSetResponse;
use orbiterx_app_server_protocol::ThreadMetadataGitInfoUpdateParams;
use orbiterx_app_server_protocol::ThreadMetadataUpdateParams;
use orbiterx_app_server_protocol::ThreadMetadataUpdateResponse;
use orbiterx_app_server_protocol::ThreadNameUpdatedNotification;
use orbiterx_app_server_protocol::ThreadReadParams;
use orbiterx_app_server_protocol::ThreadReadResponse;
use orbiterx_app_server_protocol::ThreadRealtimeAppendAudioParams;
use orbiterx_app_server_protocol::ThreadRealtimeAppendAudioResponse;
use orbiterx_app_server_protocol::ThreadRealtimeAppendSpeechParams;
use orbiterx_app_server_protocol::ThreadRealtimeAppendSpeechResponse;
use orbiterx_app_server_protocol::ThreadRealtimeAppendTextParams;
use orbiterx_app_server_protocol::ThreadRealtimeAppendTextResponse;
use orbiterx_app_server_protocol::ThreadRealtimeListVoicesResponse;
use orbiterx_app_server_protocol::ThreadRealtimeStartParams;
use orbiterx_app_server_protocol::ThreadRealtimeStartResponse;
use orbiterx_app_server_protocol::ThreadRealtimeStartTransport;
use orbiterx_app_server_protocol::ThreadRealtimeStopParams;
use orbiterx_app_server_protocol::ThreadRealtimeStopResponse;
use orbiterx_app_server_protocol::ThreadResumeInitialTurnsPageParams;
use orbiterx_app_server_protocol::ThreadResumeParams;
use orbiterx_app_server_protocol::ThreadResumeResponse;
use orbiterx_app_server_protocol::ThreadRollbackParams;
use orbiterx_app_server_protocol::ThreadSearchOccurrence;
use orbiterx_app_server_protocol::ThreadSearchOccurrencesParams;
use orbiterx_app_server_protocol::ThreadSearchOccurrencesResponse;
use orbiterx_app_server_protocol::ThreadSearchParams;
use orbiterx_app_server_protocol::ThreadSearchResponse;
use orbiterx_app_server_protocol::ThreadSearchResult;
use orbiterx_app_server_protocol::ThreadSearchTextRange;
use orbiterx_app_server_protocol::ThreadSetNameParams;
use orbiterx_app_server_protocol::ThreadSetNameResponse;
use orbiterx_app_server_protocol::ThreadSettings;
use orbiterx_app_server_protocol::ThreadSettingsUpdateParams;
use orbiterx_app_server_protocol::ThreadSettingsUpdateResponse;
use orbiterx_app_server_protocol::ThreadShellCommandParams;
use orbiterx_app_server_protocol::ThreadShellCommandResponse;
use orbiterx_app_server_protocol::ThreadSortKey;
use orbiterx_app_server_protocol::ThreadSourceKind;
use orbiterx_app_server_protocol::ThreadStartParams;
use orbiterx_app_server_protocol::ThreadStartResponse;
use orbiterx_app_server_protocol::ThreadStartedNotification;
use orbiterx_app_server_protocol::ThreadStatus;
use orbiterx_app_server_protocol::ThreadTurnsListParams;
use orbiterx_app_server_protocol::ThreadTurnsListResponse;
use orbiterx_app_server_protocol::ThreadUnarchiveParams;
use orbiterx_app_server_protocol::ThreadUnarchiveResponse;
use orbiterx_app_server_protocol::ThreadUnarchivedNotification;
use orbiterx_app_server_protocol::ThreadUnsubscribeParams;
use orbiterx_app_server_protocol::ThreadUnsubscribeResponse;
use orbiterx_app_server_protocol::ThreadUnsubscribeStatus;
use orbiterx_app_server_protocol::Turn;
use orbiterx_app_server_protocol::TurnEnvironmentParams;
use orbiterx_app_server_protocol::TurnError;
use orbiterx_app_server_protocol::TurnInterruptParams;
use orbiterx_app_server_protocol::TurnInterruptResponse;
use orbiterx_app_server_protocol::TurnItemsView;
use orbiterx_app_server_protocol::TurnStartParams;
use orbiterx_app_server_protocol::TurnStartResponse;
use orbiterx_app_server_protocol::TurnStatus;
use orbiterx_app_server_protocol::TurnSteerParams;
use orbiterx_app_server_protocol::TurnSteerResponse;
use orbiterx_app_server_protocol::UserInput as V2UserInput;
use orbiterx_app_server_protocol::WindowsSandboxReadiness;
use orbiterx_app_server_protocol::WindowsSandboxReadinessResponse;
use orbiterx_app_server_protocol::WindowsSandboxSetupCompletedNotification;
use orbiterx_app_server_protocol::WindowsSandboxSetupMode;
use orbiterx_app_server_protocol::WindowsSandboxSetupStartParams;
use orbiterx_app_server_protocol::WindowsSandboxSetupStartResponse;
use orbiterx_app_server_protocol::WorkspaceMessage;
use orbiterx_app_server_protocol::WorkspaceMessageType;
use orbiterx_arg0::Arg0DispatchPaths;
use orbiterx_backend_client::AddCreditsNudgeCreditType as BackendAddCreditsNudgeCreditType;
use orbiterx_backend_client::Client as BackendClient;
use orbiterx_backend_client::ConsumeRateLimitResetCreditCode as BackendConsumeRateLimitResetCreditCode;
use orbiterx_backend_client::OrbiterXWorkspaceMessage as BackendWorkspaceMessage;
use orbiterx_backend_client::OrbiterXWorkspaceMessageType as BackendWorkspaceMessageType;
use orbiterx_backend_client::OrbiterXWorkspaceMessagesResponse as BackendWorkspaceMessagesResponse;
use orbiterx_backend_client::RateLimitResetCreditDetails as BackendRateLimitResetCreditDetails;
use orbiterx_backend_client::RateLimitResetCreditsDetails as BackendRateLimitResetCreditsDetails;
use orbiterx_backend_client::RequestError as BackendRequestError;
use orbiterx_backend_client::TokenUsageProfile;
use orbiterx_chatgpt::connectors;
use orbiterx_chatgpt::workspace_settings;
use orbiterx_config::CloudConfigBundleLoadError;
use orbiterx_config::CloudConfigBundleLoadErrorCode;
use orbiterx_config::ConfigLayerStack;
use orbiterx_config::loader::project_trust_key;
use orbiterx_config::types::McpServerTransportConfig;
use orbiterx_connectors::AppInfo;
use orbiterx_core::ForkSnapshot;
use orbiterx_core::McpManager;
use orbiterx_core::NewThread;
use orbiterx_core::OrbiterXThread;
use orbiterx_core::OrbiterXThreadSettingsOverrides;
#[cfg(test)]
use orbiterx_core::SessionMeta;
use orbiterx_core::StartThreadOptions;
use orbiterx_core::SteerInputError;
use orbiterx_core::ThreadConfigSnapshot;
use orbiterx_core::ThreadManager;
use orbiterx_core::config::Config;
use orbiterx_core::config::ConfigOverrides;
use orbiterx_core::config::NetworkProxyAuditMetadata;
use orbiterx_core::config::edit::ConfigEdit;
use orbiterx_core::config::edit::ConfigEditsBuilder;
use orbiterx_core::connectors::AccessibleConnectorsStatus;
use orbiterx_core::exec::ExecCapturePolicy;
use orbiterx_core::exec::ExecExpiration;
use orbiterx_core::exec::ExecParams;
use orbiterx_core::exec_env::create_env;
use orbiterx_core::path_utils;
#[cfg(test)]
use orbiterx_core::read_head_for_summary;
use orbiterx_core::sandboxing::SandboxPermissions;
use orbiterx_core::truncate_rollout_after_turn_id;
use orbiterx_core::truncate_rollout_before_turn_id;
use orbiterx_core::windows_sandbox::WindowsSandboxLevelExt;
use orbiterx_core::windows_sandbox::WindowsSandboxSetupMode as CoreWindowsSandboxSetupMode;
use orbiterx_core::windows_sandbox::WindowsSandboxSetupRequest;
use orbiterx_core::windows_sandbox::sandbox_setup_is_complete;
use orbiterx_core_plugins::PluginInstallError as CorePluginInstallError;
use orbiterx_core_plugins::PluginInstallRequest;
use orbiterx_core_plugins::PluginReadRequest;
use orbiterx_core_plugins::PluginUninstallError as CorePluginUninstallError;
use orbiterx_core_plugins::PluginsManager;
use orbiterx_core_plugins::loader::load_plugin_apps;
use orbiterx_core_plugins::loader::load_plugin_mcp_servers;
use orbiterx_core_plugins::manifest::PluginManifestInterface;
use orbiterx_core_plugins::marketplace::MarketplaceError;
use orbiterx_core_plugins::marketplace::MarketplacePluginSource;
use orbiterx_core_plugins::marketplace_add::MarketplaceAddError;
use orbiterx_core_plugins::marketplace_add::MarketplaceAddRequest;
use orbiterx_core_plugins::marketplace_add::add_marketplace as add_marketplace_to_orbiterx_home;
use orbiterx_core_plugins::marketplace_remove::MarketplaceRemoveError;
use orbiterx_core_plugins::marketplace_remove::MarketplaceRemoveRequest as CoreMarketplaceRemoveRequest;
use orbiterx_core_plugins::marketplace_remove::remove_marketplace;
use orbiterx_core_plugins::remote::RemoteMarketplace;
use orbiterx_core_plugins::remote::RemoteMarketplaceSource;
use orbiterx_core_plugins::remote::RemotePluginCatalogError;
use orbiterx_core_plugins::remote::RemotePluginDetail as RemoteCatalogPluginDetail;
use orbiterx_core_plugins::remote::RemotePluginServiceConfig;
use orbiterx_core_plugins::remote::RemotePluginShareContext as RemoteCatalogPluginShareContext;
use orbiterx_core_plugins::remote::RemotePluginShareSummary as RemoteCatalogPluginShareSummary;
use orbiterx_core_plugins::remote::RemotePluginSummary as RemoteCatalogPluginSummary;
use orbiterx_exec_server::EnvironmentManager;
use orbiterx_exec_server::EnvironmentObservedStatus;
use orbiterx_exec_server::LOCAL_ENVIRONMENT_ID;
use orbiterx_exec_server::LOCAL_FS;
use orbiterx_features::FEATURES;
use orbiterx_features::Feature;
use orbiterx_features::Stage;
use orbiterx_feedback::FeedbackAttachmentPath;
use orbiterx_feedback::FeedbackUploadOptions;
use orbiterx_feedback::OrbiterXFeedback;
use orbiterx_git_utils::git_diff_to_remote;
use orbiterx_git_utils::resolve_root_git_project_for_trust;
use orbiterx_login::AuthManager;
use orbiterx_login::LoginSuccessPage;
use orbiterx_login::LoginSuccessPageBrand;
use orbiterx_login::ORBITERX_OPEN_APP_URL;
use orbiterx_login::OrbiterXAuth;
use orbiterx_login::ServerOptions as LoginServerOptions;
use orbiterx_login::ShutdownHandle;
use orbiterx_login::complete_device_code_login;
use orbiterx_login::login_with_api_key;
use orbiterx_login::login_with_bedrock_api_key;
use orbiterx_login::oauth_client_id;
use orbiterx_login::request_device_code;
use orbiterx_login::run_login_server;
use orbiterx_mcp::McpRuntimeContext;
use orbiterx_mcp::McpServerStatusSnapshot;
use orbiterx_mcp::McpSnapshotDetail;
use orbiterx_mcp::collect_mcp_server_status_snapshot_with_detail;
use orbiterx_mcp::discover_supported_scopes_with_http_client;
use orbiterx_mcp::read_mcp_resource as read_mcp_resource_without_thread;
use orbiterx_mcp::resolve_oauth_scopes;
use orbiterx_memories_write::clear_memory_roots_contents;
use orbiterx_model_provider::create_model_provider;
use orbiterx_models_manager::collaboration_mode_presets::builtin_collaboration_mode_presets;
use orbiterx_protocol::ThreadId;
use orbiterx_protocol::config_types::CollaborationMode;
use orbiterx_protocol::config_types::ForcedLoginMethod;
use orbiterx_protocol::config_types::Personality;
use orbiterx_protocol::config_types::ReasoningSummary;
use orbiterx_protocol::config_types::TrustLevel;
use orbiterx_protocol::config_types::WindowsSandboxLevel;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::error::Result as OrbiterXResult;
#[cfg(test)]
use orbiterx_protocol::items::TurnItem;
use orbiterx_protocol::models::ResponseItem;
use orbiterx_protocol::openai_models::ReasoningEffort;
#[cfg(test)]
use orbiterx_protocol::permissions::FileSystemSandboxPolicy;
use orbiterx_protocol::protocol::AgentStatus;
use orbiterx_protocol::protocol::ConversationAudioParams;
use orbiterx_protocol::protocol::ConversationSpeechParams;
use orbiterx_protocol::protocol::ConversationStartParams;
use orbiterx_protocol::protocol::ConversationStartTransport;
use orbiterx_protocol::protocol::ConversationTextParams;
use orbiterx_protocol::protocol::EventMsg;
#[cfg(test)]
use orbiterx_protocol::protocol::GitInfo as CoreGitInfo;
use orbiterx_protocol::protocol::InitialHistory;
use orbiterx_protocol::protocol::McpAuthStatus as CoreMcpAuthStatus;
use orbiterx_protocol::protocol::Op;
use orbiterx_protocol::protocol::RealtimeVoicesList;
use orbiterx_protocol::protocol::ResumedHistory;
use orbiterx_protocol::protocol::ReviewDelivery as CoreReviewDelivery;
use orbiterx_protocol::protocol::ReviewRequest;
use orbiterx_protocol::protocol::ReviewTarget as CoreReviewTarget;
use orbiterx_protocol::protocol::RolloutItem;
use orbiterx_protocol::protocol::SessionConfiguredEvent;
#[cfg(test)]
use orbiterx_protocol::protocol::SessionMetaLine;
use orbiterx_protocol::protocol::TurnEnvironmentSelection;
use orbiterx_protocol::protocol::TurnEnvironmentSelections;
use orbiterx_protocol::protocol::W3cTraceContext;
use orbiterx_protocol::protocol::strip_user_message_prefix;
use orbiterx_protocol::user_input::MAX_USER_INPUT_TEXT_CHARS;
use orbiterx_protocol::user_input::UserInput as CoreInputItem;
use orbiterx_rmcp_client::perform_oauth_login_return_url_with_http_client;
use orbiterx_rollout::is_persisted_rollout_item;
use orbiterx_rollout::state_db::StateDbHandle;
use orbiterx_rollout::state_db::reconcile_rollout;
use orbiterx_state::ThreadMetadata;
use orbiterx_state::log_db::LogDbLayer;
use orbiterx_thread_store::ArchiveThreadParams as StoreArchiveThreadParams;
use orbiterx_thread_store::DeleteThreadParams as StoreDeleteThreadParams;
use orbiterx_thread_store::GitInfoPatch as StoreGitInfoPatch;
use orbiterx_thread_store::ListItemsParams as StoreListItemsParams;
use orbiterx_thread_store::ListThreadsParams as StoreListThreadsParams;
use orbiterx_thread_store::ListTurnsParams as StoreListTurnsParams;
use orbiterx_thread_store::LoadThreadHistoryParams as StoreLoadThreadHistoryParams;
use orbiterx_thread_store::LocalThreadStore;
use orbiterx_thread_store::ReadThreadByRolloutPathParams as StoreReadThreadByRolloutPathParams;
use orbiterx_thread_store::ReadThreadParams as StoreReadThreadParams;
use orbiterx_thread_store::SearchThreadOccurrencesParams as StoreSearchThreadOccurrencesParams;
use orbiterx_thread_store::SearchThreadsParams as StoreSearchThreadsParams;
use orbiterx_thread_store::SortDirection as StoreSortDirection;
use orbiterx_thread_store::StoredThread;
use orbiterx_thread_store::StoredTurn;
use orbiterx_thread_store::StoredTurnItemsView;
use orbiterx_thread_store::StoredTurnStatus;
use orbiterx_thread_store::ThreadMetadataPatch as StoreThreadMetadataPatch;
use orbiterx_thread_store::ThreadRelationFilter as StoreThreadRelationFilter;
use orbiterx_thread_store::ThreadSortKey as StoreThreadSortKey;
use orbiterx_thread_store::ThreadStore;
use orbiterx_thread_store::ThreadStoreError;
use orbiterx_utils_absolute_path::AbsolutePathBuf;
use orbiterx_utils_pty::DEFAULT_OUTPUT_BYTES_CAP;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Error as IoError;
use std::path::Path;
use std::path::PathBuf;
use std::result::Result;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;
use tokio::sync::SemaphorePermit;
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::sync::DropGuard;
use tokio_util::task::TaskTracker;
use toml::Value as TomlValue;
use tracing::Instrument;
use tracing::error;
use tracing::info;
use tracing::warn;
use uuid::Uuid;

#[cfg(test)]
use orbiterx_app_server_protocol::ServerRequest;

mod account_processor;
mod apps_processor;
mod bedrock_auth;
mod catalog_processor;
mod command_exec_processor;
mod config_processor;
mod environment_processor;
mod feedback_doctor_report;
mod feedback_processor;
mod fs_processor;
mod git_processor;
mod initialize_processor;
mod marketplace_processor;
mod mcp_processor;
mod plugins;
mod process_exec_processor;
mod remote_control_processor;
mod search;
mod thread_fork_goal;
mod thread_processor;
mod token_usage_replay;
mod turn_processor;
mod windows_sandbox_processor;

pub(crate) use account_processor::AccountRequestProcessor;
pub(crate) use apps_processor::AppsRequestProcessor;
pub(crate) use catalog_processor::CatalogRequestProcessor;
pub(crate) use command_exec_processor::CommandExecRequestProcessor;
pub(crate) use config_processor::ConfigRequestProcessor;
pub(crate) use environment_processor::EnvironmentRequestProcessor;
pub(crate) use feedback_processor::FeedbackRequestProcessor;
pub(crate) use fs_processor::FsRequestProcessor;
pub(crate) use git_processor::GitRequestProcessor;
pub(crate) use initialize_processor::InitializeRequestProcessor;
pub(crate) use marketplace_processor::MarketplaceRequestProcessor;
pub(crate) use mcp_processor::McpRequestProcessor;
pub(crate) use plugins::PluginRequestProcessor;
pub(crate) use process_exec_processor::ProcessExecRequestProcessor;
pub(crate) use remote_control_processor::RemoteControlRequestProcessor;
pub(crate) use search::SearchRequestProcessor;
pub(crate) use thread_goal_processor::ThreadGoalRequestProcessor;
pub(crate) use thread_processor::ThreadRequestProcessor;
pub(crate) use turn_processor::TurnRequestProcessor;
pub(crate) use windows_sandbox_processor::WindowsSandboxRequestProcessor;

use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use crate::filters::compute_source_filters;
use crate::filters::source_kind_matches;
use crate::thread_state::ConnectionCapabilities;
use crate::thread_state::ThreadListenerCommand;
use crate::thread_state::ThreadState;
use crate::thread_state::ThreadStateManager;
use token_usage_replay::latest_token_usage_turn_id_from_rollout_items;
use token_usage_replay::send_thread_token_usage_update_to_connection;

fn resolve_request_cwd(cwd: Option<PathBuf>) -> Result<Option<AbsolutePathBuf>, JSONRPCErrorError> {
    cwd.map(|cwd| {
        AbsolutePathBuf::relative_to_current_dir(path_utils::normalize_for_native_workdir(cwd))
            .map_err(|err| invalid_request(format!("invalid cwd: {err}")))
    })
    .transpose()
}

fn resolve_turn_environment_selections(
    thread_manager: &ThreadManager,
    environments: Option<Vec<TurnEnvironmentParams>>,
) -> Result<Option<Vec<TurnEnvironmentSelection>>, JSONRPCErrorError> {
    let Some(environments) = environments else {
        return Ok(None);
    };
    let mut selections = Vec::with_capacity(environments.len());
    for environment in environments {
        let environment_id = environment.environment_id;
        let cwd = environment
            .cwd
            .to_inferred_path_uri()
            .ok_or_else(|| {
                invalid_request(format!(
                    "invalid cwd for environment `{environment_id}`: path `{}` does not use absolute POSIX or Windows path syntax",
                    environment.cwd
                ))
            })?;
        let workspace_roots = environment
            .runtime_workspace_roots
            .map(|roots| {
                let mut resolved_roots = Vec::new();
                for root in roots {
                    let root = root.to_inferred_path_uri().ok_or_else(|| {
                        invalid_request(format!(
                            "invalid runtime workspace root for environment `{environment_id}`: path `{root}` does not use absolute POSIX or Windows path syntax"
                        ))
                    })?;
                    if !resolved_roots.contains(&root) {
                        resolved_roots.push(root);
                    }
                }
                Ok::<_, JSONRPCErrorError>(resolved_roots)
            })
            .transpose()?
            .unwrap_or_else(|| vec![cwd.clone()]);
        selections.push(TurnEnvironmentSelection {
            environment_id,
            cwd,
            workspace_roots,
        });
    }
    thread_manager
        .validate_environment_selections(&selections)
        .map_err(environment_selection_error)?;
    Ok(Some(selections))
}

fn resolve_runtime_workspace_roots(workspace_roots: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf> {
    let mut resolved_roots = Vec::new();
    for root in workspace_roots {
        if !resolved_roots.iter().any(|existing| existing == &root) {
            resolved_roots.push(root);
        }
    }
    resolved_roots
}

mod config_errors;
mod request_errors;
mod thread_delete;
mod thread_goal_processor;
mod thread_lifecycle;
mod thread_resume_redaction;
mod thread_summary;

use self::config_errors::*;
use self::request_errors::*;
use self::thread_goal_processor::api_thread_goal_from_state;
use self::thread_lifecycle::*;
use self::thread_resume_redaction::*;
use self::thread_summary::*;

pub(crate) use self::thread_lifecycle::populate_thread_turns_from_history;
pub(crate) use self::thread_processor::thread_from_stored_thread;
#[cfg(test)]
pub(crate) use self::thread_summary::read_summary_from_rollout;
#[cfg(test)]
pub(crate) use self::thread_summary::summary_to_thread;
pub(crate) use self::thread_summary::thread_settings_from_config_snapshot;
pub(crate) use self::thread_summary::thread_settings_from_core_snapshot;

pub(crate) fn build_legacy_api_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn> {
    let mut builder = ThreadHistoryBuilder::new();
    for item in items {
        if is_persisted_rollout_item(item, orbiterx_protocol::protocol::ThreadHistoryMode::Legacy) {
            builder.handle_rollout_item(item);
        }
    }
    builder.finish()
}
