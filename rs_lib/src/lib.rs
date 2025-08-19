use std::path::PathBuf;

use deno_config::workspace::WorkspaceDirectory;
use deno_config::workspace::WorkspaceDiscoverOptions;
use deno_config::workspace::WorkspaceDiscoverStart;
use url::Url;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn resolve_config_with_deploy_config(root_path: String) -> Result<Option<String>, JsValue> {
  let result = inner_resolve(root_path);
  result.map_err(|err| create_js_error(&err))
}


fn inner_resolve(root_path: String) -> Result<Option<String>, anyhow::Error> {
  let real_sys = sys_traits::impls::RealSys;
  let root_path = resolve_absolute_path(root_path)?;
  let root_paths = [root_path];
  let workspace_dir = WorkspaceDirectory::discover(
    &real_sys,
    WorkspaceDiscoverStart::Paths(&root_paths),
    &WorkspaceDiscoverOptions {
      additional_config_file_names: &[],
      deno_json_cache: None,
      pkg_json_cache: None,
      workspace_cache: None,
      discover_pkg_json: true,
      maybe_vendor_override: None,
    },
  )?;
  if let Some(deno_json) = workspace_dir.maybe_deno_json() {
    if let Some(_) = deno_json.to_deploy_config()? {
      return Ok(Some(deno_json.specifier.to_string()));
    }
  }
  if let Some(deno_json) = workspace_dir.workspace.root_deno_json() {
    if let Some(_) = deno_json.to_deploy_config()? {
      return Ok(Some(deno_json.specifier.to_string()));
    }
  }
  Ok(None)
}

fn resolve_absolute_path(
  path: String,
) -> Result<PathBuf, anyhow::Error> {
  if path.starts_with("file:///") {
    let url = Url::parse(&path)?;
    Ok(deno_path_util::url_to_file_path(&url)?)
  } else {
    Ok(sys_traits::impls::wasm_string_to_path(path))
  }
}

fn create_js_error(err: &anyhow::Error) -> JsValue {
  wasm_bindgen::JsError::new(&format!("{:#}", err)).into()
}
