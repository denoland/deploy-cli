use deno_config::glob::FileCollector;
use deno_config::glob::FilePatterns;
use deno_config::glob::PathOrPatternSet;
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
  let result =
    inner_resolve_config(root_path, ignore_paths, allow_node_modules);
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

  let mut pattern = FilePatterns::new_with_base(root_path.clone());

  if !ignore_paths.is_empty() {
    let exclude = PathOrPatternSet::from_exclude_relative_path_or_patterns(
      &root_path,
      &ignore_paths,
    )?;
    pattern
      .exclude
      .append(exclude.into_path_or_patterns().into_iter());
  }

  if let Some(config) = workspace_dir.to_deploy_config(pattern)? {
    let specifier = workspace_dir
      .member_deno_json()
      .filter(|config| config.to_deploy_config().is_ok())
      .map(|member| member.specifier.to_string())
      .or_else(|| {
        workspace_dir.workspace.root_deno_json()
          .filter(|config| config.to_deploy_config().is_ok())
          .map(|member| member.specifier.to_string())
      })
      .expect(
        "workspace_dir.to_deploy_config should have resolved a specifier",
      );
    let files =
      collect_files(&real_sys, root_path, config.files, allow_node_modules);
    Ok(ConfigLookup {
      path: Some(specifier),
      files,
    })
  } else {
    let path = workspace_dir
      .member_deno_json()
      .map(|member| member.specifier.to_string())
      .or_else(|| {
        workspace_dir.workspace.root_deno_json()
          .map(|member| member.specifier.to_string())
      });
    Ok(ConfigLookup {
      path,
      files: collect_files(
        &real_sys,
        root_path.clone(),
        FilePatterns::new_with_base(root_path),
        allow_node_modules,
      ),
    })
  }
}

fn collect_files(
  real_sys: &sys_traits::impls::RealSys,
  root_path: PathBuf,
  files: FilePatterns,
  allow_node_modules: bool,
) -> Vec<String> {
  let mut collector =
    FileCollector::new(|entry| entry.path.starts_with(&root_path))
      .ignore_git_folder()
      .use_gitignore();

  if !allow_node_modules {
    collector = collector.ignore_node_modules();
  }

  collector
    .collect_file_patterns(real_sys, &files)
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
