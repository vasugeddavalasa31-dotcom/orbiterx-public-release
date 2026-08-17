use crate::config::Config;
use serde_json::Value;
use std::result::Result;

pub async fn validate_api_key(
    provider_type: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let provider_type_lower = provider_type.to_lowercase();
    let is_openrouter = provider_type_lower == "openrouter"
        || base_url.is_some_and(|url| url.contains("openrouter.ai"));
    let is_ollama = provider_type_lower == "ollama"
        || base_url.is_some_and(|url| url.contains("localhost") || url.contains("127.0.0.1"));

    if is_openrouter {
        let key_url = format!(
            "{}/key",
            base_url
                .unwrap_or("https://openrouter.ai/api/v1")
                .trim_end_matches('/')
        );
        let key = api_key.ok_or_else(|| "API Key is required for OpenRouter".to_string())?;

        let resp = client
            .get(&key_url)
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await
            .map_err(|e| format!("Failed to connect to OpenRouter: {e}"))?;

        if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
            return Err("Invalid OpenRouter API Key".to_string());
        }

        if !resp.status().is_success() {
            return Err(format!(
                "OpenRouter returned HTTP error status {}",
                resp.status()
            ));
        }

        if let Ok(val) = resp.json::<Value>().await
            && let Some(data) = val.get("data")
        {
            let limit = data.get("limit").and_then(serde_json::Value::as_f64);
            let usage = data.get("usage").and_then(serde_json::Value::as_f64);
            let is_active = data
                .get("is_active")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);

            if !is_active {
                return Err("OpenRouter API key is inactive".to_string());
            }
            if let (Some(lim), Some(usg)) = (limit, usage)
                && usg >= lim
            {
                return Err("OpenRouter credit limit exhausted (balance is zero)".to_string());
            }
        }

        // Show model list from OpenRouter /models endpoint
        let models_url = format!(
            "{}/models",
            base_url
                .unwrap_or("https://openrouter.ai/api/v1")
                .trim_end_matches('/')
        );
        if let Ok(models_resp) = client.get(&models_url).send().await
            && models_resp.status().is_success()
            && let Ok(val) = models_resp.json::<Value>().await
            && let Some(data) = val.get("data").and_then(|d| d.as_array())
        {
            println!("\nAvailable OpenRouter Models:");
            for m in data.iter().take(20) {
                if let Some(id) = m.get("id").and_then(|id| id.as_str()) {
                    println!("  - {id}");
                }
            }
            if data.len() > 20 {
                println!("  ... and {} more models", data.len() - 20);
            }
            println!();
        }
    } else if is_ollama {
        let base = base_url
            .unwrap_or("http://localhost:11434")
            .trim_end_matches('/');
        let url_prefix = if base.ends_with("/v1") {
            base.to_string()
        } else {
            format!("{base}/v1")
        };
        let probe_url = format!("{url_prefix}/models");
        let resp = client.get(&probe_url).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                // Success
            }
            _ => {
                return Err(format!(
                    "Ollama server is not running or unreachable at {base}. Please start it with `ollama serve` or download it from https://ollama.com"
                ));
            }
        }
    } else {
        // Direct OpenAI/Gemini/Anthropic
        let is_anthropic = model.is_some_and(|m| m.contains("claude"))
            || base_url.is_some_and(|url| url.contains("anthropic.com"));

        if is_anthropic {
            let url_prefix = base_url.unwrap_or("https://api.anthropic.com/v1");
            let url = format!("{}/messages", url_prefix.trim_end_matches('/'));
            let key = api_key.ok_or_else(|| "API Key is required for Anthropic".to_string())?;

            let body = serde_json::json!({
                "model": model.unwrap_or("claude-3-5-sonnet-20241022"),
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1
            });

            let resp = client
                .post(&url)
                .json(&body)
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .send()
                .await
                .map_err(|e| format!("Failed to connect to Anthropic: {e}"))?;

            if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
                return Err("Invalid Anthropic API Key".to_string());
            }
        } else {
            let url_prefix = base_url.unwrap_or("https://api.openai.com/v1");
            let url = format!("{}/models", url_prefix.trim_end_matches('/'));
            let key = api_key.ok_or_else(|| "API Key is required".to_string())?;

            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {key}"))
                .send()
                .await
                .map_err(|e| format!("Failed to connect to model provider: {e}"))?;

            if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
                return Err("Invalid API Key".to_string());
            }
        }
    }

    Ok(())
}

pub async fn run_interactive_startup_prompt_if_needed(config: &mut Config) -> Result<(), String> {
    let mut api_key = config.api_key.clone();
    let mut base_url = config.base_url.clone();
    let mut provider_type = config.provider_type.clone();

    let has_key = api_key.is_some() || std::env::var("ORBITERX_API_KEY").is_ok();
    let has_provider = base_url.is_some() || provider_type.is_some();

    let sandbox_network_disabled =
        std::env::var("ORBITERX_SANDBOX_NETWORK_DISABLED").unwrap_or_default() == "1";

    if !has_key && !has_provider && !sandbox_network_disabled {
        use std::io::Write;
        use std::io::{self};
        print!(
            "No API key found. Enter OpenRouter API Key (press Enter to skip for local Ollama): "
        );
        let _ = io::stdout().flush();
        let mut input = String::new();
        if io::stdin().read_line(&mut input).is_ok() {
            let trimmed = input.trim().to_string();
            if !trimmed.is_empty() {
                // Save in OS Keychain
                use orbiterx_keyring_store::KeyringStore;
                if let Err(e) = orbiterx_keyring_store::DefaultKeyringStore.save(
                    "orbiterx",
                    "byok_api_key",
                    &trimmed,
                ) {
                    eprintln!("Warning: Failed to save API key to OS Keychain: {e}");
                } else {
                    println!("API key securely saved to OS Keychain.");
                }
                api_key = Some(trimmed);
                provider_type = Some("openrouter".to_string());
                base_url = Some("https://openrouter.ai/api/v1".to_string());

                // Write a default config to ~/.orbiterx/config.toml
                if let Some(mut home) = dirs::home_dir() {
                    home.push(".orbiterx");
                    let _ = std::fs::create_dir_all(&home);
                    home.push("config.toml");
                    if !home.exists() {
                        let default_toml = r#"[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
provider_type = "openrouter"

[features]
byok = true
"#;
                        let _ = std::fs::write(&home, default_toml);
                    }
                }
            } else {
                // Skipped, try local Ollama
                println!("Skipped. Trying local Ollama...");
                provider_type = Some("ollama".to_string());
                base_url = Some("http://localhost:11434".to_string());
            }
        }

        // Re-load config fields
        config.api_key = api_key.clone();
        config.base_url = base_url.clone();
        config.provider_type = provider_type.clone();
    }

    // Now validate!
    if (config.api_key.is_some() || config.base_url.is_some() || config.provider_type.is_some())
        && !sandbox_network_disabled
    {
        let p_type = config.provider_type.as_deref().unwrap_or("direct");
        let a_key = config.api_key.as_deref();
        let b_url = config.base_url.as_deref();
        let model_name = config.model.as_deref();

        println!("Validating credentials/balance...");
        validate_api_key(p_type, a_key, b_url, model_name).await?;
        println!("Validation successful.");
    }

    Ok(())
}
