use deno_config::glob::FilePatterns;
use deno_config::glob::{FileCollector, PathOrPatternSet};
use deno_config::workspace::WorkspaceDirectory;
use deno_config::workspace::WorkspaceDiscoverOptions;
use deno_config::workspace::WorkspaceDiscoverStart;
use serde::Serialize;
use std::path::PathBuf;
use url::Url;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
pub struct ConfigLookup {
  pub path: Option<String>,
  pub files: Vec<String>,
}

#[wasm_bindgen]
pub fn resolve_config(
  root_path: String,
  ignore_paths: Vec<String>,
  allow_node_modules: bool,
) -> Result<JsValue, JsValue> {
  let result = inner_resolve_config(root_path, ignore_paths, allow_node_modules);
  result
    .map_err(|err| create_js_error(&err))
    .map(|val| serde_wasm_bindgen::to_value(&val).unwrap())
}

fn inner_resolve_config(
  root_path: String,
  ignore_paths: Vec<String>,
  allow_node_modules: bool,
) -> Result<ConfigLookup, anyhow::Error> {
  let real_sys = sys_traits::impls::RealSys;
  let root_path = resolve_absolute_path(root_path)?;
  let root_paths = [root_path.clone()];
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
  if let Some(deno_json) = workspace_dir.member_or_root_deno_json() {
    if let Some(mut config) = deno_json.to_deploy_config()? {
      if !ignore_paths.is_empty() {
        let exclude = PathOrPatternSet::from_exclude_relative_path_or_patterns(
          &config.files.base,
          &ignore_paths,
        )?;
        config
          .files
          .exclude
          .append(exclude.into_path_or_patterns().into_iter());
      }

      let files = collect_files(&real_sys, config.files, allow_node_modules);

      return Ok(ConfigLookup {
        path: Some(deno_json.specifier.to_string()),
        files,
      });
    } else {
      let mut files_config = deno_json.to_exclude_files_config()?;
      if !ignore_paths.is_empty() {
        let exclude = PathOrPatternSet::from_exclude_relative_path_or_patterns(
          &files_config.base,
          &ignore_paths,
        )?;
        files_config
          .exclude
          .append(exclude.into_path_or_patterns().into_iter());
      }

      let files = collect_files(&real_sys, files_config, allow_node_modules);
      return Ok(ConfigLookup {
        path: Some(deno_json.specifier.to_string()),
        files,
      });
    }
  }

  Ok(ConfigLookup {
    path: None,
    files: collect_files(&real_sys, FilePatterns::new_with_base(root_path), allow_node_modules),
  })
}

fn collect_files(
  real_sys: &sys_traits::impls::RealSys,
  files: FilePatterns,
  allow_node_modules: bool,
) -> Vec<String> {
  let mut collector = FileCollector::new(|_| true)
    .ignore_git_folder()
    .use_gitignore();

  if !allow_node_modules {
    collector = collector.ignore_node_modules();
  }

  collector.collect_file_patterns(real_sys, &files)
    .into_iter()
    .map(|path| path.to_string_lossy().to_string())
    .collect::<Vec<String>>()
}

fn resolve_absolute_path(path: String) -> Result<PathBuf, anyhow::Error> {
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
