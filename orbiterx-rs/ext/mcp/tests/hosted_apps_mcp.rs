use std::sync::Arc;

use orbiterx_config::McpServerTransportConfig;
use orbiterx_core::McpManager;
use orbiterx_core::config::Config;
use orbiterx_core::config::ConfigBuilder;
use orbiterx_core_plugins::PluginsManager;
use orbiterx_extension_api::ExtensionRegistryBuilder;
use orbiterx_extension_api::McpServerContribution;
use orbiterx_extension_api::McpServerContributionContext;
use orbiterx_extension_api::McpServerContributor;
use orbiterx_login::OrbiterXAuth;
use orbiterx_mcp::ORBITERX_APPS_MCP_SERVER_NAME;
use pretty_assertions::assert_eq;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn contributes_hosted_plugin_runtime_without_an_executor() -> TestResult {
    let orbiterx_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .orbiterx_home(orbiterx_home.path().to_path_buf())
        .fallback_cwd(Some(orbiterx_home.path().to_path_buf()))
        .cli_overrides(vec![
            ("features.apps".to_string(), true.into()),
            ("chatgpt_base_url".to_string(), "https://chatgpt.com".into()),
        ])
        .build()
        .await?;
    let auth = OrbiterXAuth::create_dummy_chatgpt_auth_for_testing();
    let manager = installed_manager(&config);

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    let server = servers
        .get(ORBITERX_APPS_MCP_SERVER_NAME)
        .and_then(|server| server.configured_config())
        .ok_or("hosted plugin runtime should be contributed as a configured server")?;
    let McpServerTransportConfig::StreamableHttp { url, .. } = &server.transport else {
        panic!("hosted plugin runtime should use streamable HTTP");
    };
    assert_eq!(url, "https://chatgpt.com/backend-api/ps/mcp");

    Ok(())
}

#[tokio::test]
async fn runtime_overlay_preserves_disabled_server() -> TestResult {
    let orbiterx_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .orbiterx_home(orbiterx_home.path().to_path_buf())
        .fallback_cwd(Some(orbiterx_home.path().to_path_buf()))
        .cli_overrides(vec![
            ("features.apps".to_string(), true.into()),
            (
                "mcp_servers.orbiterx_apps.url".to_string(),
                "https://example.com/mcp".into(),
            ),
            (
                "mcp_servers.orbiterx_apps.enabled".to_string(),
                false.into(),
            ),
        ])
        .build()
        .await?;
    let auth = OrbiterXAuth::create_dummy_chatgpt_auth_for_testing();
    let manager = installed_manager(&config);

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    let server = servers
        .get(ORBITERX_APPS_MCP_SERVER_NAME)
        .ok_or("hosted plugin runtime should remain configured")?;

    assert!(!server.enabled());
    Ok(())
}

#[tokio::test]
async fn legacy_fallback_overwrites_reserved_config_without_an_extension() -> TestResult {
    let orbiterx_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .orbiterx_home(orbiterx_home.path().to_path_buf())
        .fallback_cwd(Some(orbiterx_home.path().to_path_buf()))
        .cli_overrides(vec![
            ("features.apps".to_string(), true.into()),
            (
                "mcp_servers.orbiterx_apps.url".to_string(),
                "https://example.com/mcp".into(),
            ),
        ])
        .build()
        .await?;
    let auth = OrbiterXAuth::create_dummy_chatgpt_auth_for_testing();
    let manager = McpManager::new(Arc::new(PluginsManager::new(
        config.orbiterx_home.to_path_buf(),
    )));

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    let server = servers
        .get(ORBITERX_APPS_MCP_SERVER_NAME)
        .and_then(|server| server.configured_config())
        .ok_or("legacy Apps MCP should be present")?;
    let McpServerTransportConfig::StreamableHttp { url, .. } = &server.transport else {
        panic!("legacy Apps MCP should use streamable HTTP");
    };
    assert_eq!(url, "https://chatgpt.com/backend-api/wham/apps");

    Ok(())
}

#[tokio::test]
async fn later_extension_can_remove_same_name_registration() -> TestResult {
    let orbiterx_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .orbiterx_home(orbiterx_home.path().to_path_buf())
        .fallback_cwd(Some(orbiterx_home.path().to_path_buf()))
        .cli_overrides(vec![("features.apps".to_string(), true.into())])
        .build()
        .await?;
    let auth = OrbiterXAuth::create_dummy_chatgpt_auth_for_testing();
    let mut builder = ExtensionRegistryBuilder::new();
    orbiterx_mcp_extension::install(&mut builder);
    builder.mcp_server_contributor(Arc::new(RemoveOrbiterXApps));
    let manager = McpManager::new_with_extensions(
        Arc::new(PluginsManager::new(config.orbiterx_home.to_path_buf())),
        Arc::new(builder.build()),
        orbiterx_core::OrbiterXAppsToolsCache::default(),
    );

    let servers = manager.effective_servers(&config, Some(&auth)).await;

    assert!(!servers.contains_key(ORBITERX_APPS_MCP_SERVER_NAME));
    Ok(())
}

#[tokio::test]
async fn hosted_apps_mcp_requires_chatgpt_auth() -> TestResult {
    let orbiterx_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .orbiterx_home(orbiterx_home.path().to_path_buf())
        .fallback_cwd(Some(orbiterx_home.path().to_path_buf()))
        .cli_overrides(vec![("features.apps".to_string(), true.into())])
        .build()
        .await?;
    let auth = OrbiterXAuth::from_api_key("test");
    let manager = installed_manager(&config);

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    assert!(!servers.contains_key(ORBITERX_APPS_MCP_SERVER_NAME));

    Ok(())
}

#[tokio::test]
async fn disabled_apps_remove_reserved_server_config_for_all_hosts() -> TestResult {
    let orbiterx_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .orbiterx_home(orbiterx_home.path().to_path_buf())
        .fallback_cwd(Some(orbiterx_home.path().to_path_buf()))
        .cli_overrides(vec![
            ("features.apps".to_string(), false.into()),
            (
                "mcp_servers.orbiterx_apps.url".to_string(),
                "https://example.com/mcp".into(),
            ),
        ])
        .build()
        .await?;
    let managers = [
        installed_manager(&config),
        McpManager::new(Arc::new(PluginsManager::new(
            config.orbiterx_home.to_path_buf(),
        ))),
    ];
    for manager in managers {
        let servers = manager.runtime_servers(&config).await;
        assert!(!servers.contains_key(ORBITERX_APPS_MCP_SERVER_NAME));
    }
    Ok(())
}

fn installed_manager(config: &Config) -> McpManager {
    let mut builder = ExtensionRegistryBuilder::new();
    orbiterx_mcp_extension::install(&mut builder);
    McpManager::new_with_extensions(
        Arc::new(PluginsManager::new(config.orbiterx_home.to_path_buf())),
        Arc::new(builder.build()),
        orbiterx_core::OrbiterXAppsToolsCache::default(),
    )
}

struct RemoveOrbiterXApps;

impl McpServerContributor<Config> for RemoveOrbiterXApps {
    fn id(&self) -> &'static str {
        "remove_orbiterx_apps"
    }

    fn contribute<'a>(
        &'a self,
        _context: McpServerContributionContext<'a, Config>,
    ) -> orbiterx_extension_api::ExtensionFuture<'a, Vec<McpServerContribution>> {
        Box::pin(async move {
            vec![McpServerContribution::Remove {
                name: ORBITERX_APPS_MCP_SERVER_NAME.to_string(),
            }]
        })
    }
}
