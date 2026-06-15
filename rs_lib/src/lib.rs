use deno_config::glob::FileCollector;
use deno_config::glob::FilePatterns;
use deno_config::glob::PathOrPatternSet;
use deno_config::workspace::WorkspaceDirectory;
use deno_config::workspace::WorkspaceDiscoverOptions;
use deno_config::workspace::WorkspaceDiscoverStart;
use serde::Serialize;
use std::path::PathBuf;
use sys_traits::FsMetadata;
use url::Url;
use wasm_bindgen::prelude::*;

fn debug_log(debug: bool, msg: &str) {
  if debug {
    web_sys::console::log_1(&serde_wasm_bindgen::to_value(&format!("[rs_lib] {}", msg)).unwrap());
  }
}

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
  collect_files: bool,
  debug: bool,
) -> Result<JsValue, JsValue> {
  let result = inner_resolve_config(
    root_path,
    ignore_paths,
    allow_node_modules,
    collect_files,
    debug,
  );
  result
    .map_err(|err| create_js_error(&err))
    .map(|val| serde_wasm_bindgen::to_value(&val).unwrap())
}

// `collect_files` toggles the downward source-file walk. Deploy-config metadata
// (the `deno.json` path that holds `deploy.org` / `deploy.app`) is found via the
// upward workspace discovery above, which never descends into cwd. The expensive
// (and, from `/`, pathological) part is `collect_files`, so management/sandbox
// commands pass `collect_files=false` and only local publish flows pass `true`.
fn inner_resolve_config(
  root_path: String,
  ignore_paths: Vec<String>,
  allow_node_modules: bool,
  collect_files: bool,
  debug: bool,
) -> Result<ConfigLookup, anyhow::Error> {
  debug_log(
    debug,
    &format!(
      "resolve_config(root_path={:?}, ignore_paths={:?}, allow_node_modules={}, collect_files={})",
      root_path, ignore_paths, allow_node_modules, collect_files
    ),
  );

  let real_sys = sys_traits::impls::RealSys;
  let root_path = resolve_absolute_path(root_path)?;
  debug_log(debug, &format!("resolved absolute root_path={:?}", root_path));

  // When --config points to a file (not a directory), use ConfigFile
  // discovery so non-standard filenames like deno-staging.json work.
  let is_config_file = real_sys.fs_is_file(&root_path).unwrap_or(false);
  debug_log(debug, &format!("is_config_file={}", is_config_file));
  let dir_path = if is_config_file {
    root_path.parent().unwrap().to_path_buf()
  } else {
    root_path.clone()
  };
  debug_log(debug, &format!("dir_path={:?}", dir_path));

  let dir_paths = [dir_path.clone()];
  let discover_start = if is_config_file {
    WorkspaceDiscoverStart::ConfigFile(&root_path)
  } else {
    WorkspaceDiscoverStart::Paths(&dir_paths)
  };

  let workspace_dir = WorkspaceDirectory::discover(
    &real_sys,
    discover_start,
    &WorkspaceDiscoverOptions {
      additional_config_file_names: &[],
      deno_json_cache: None,
      pkg_json_cache: None,
      workspace_cache: None,
      discover_pkg_json: true,
      maybe_vendor_override: None,
    },
  )?;
  debug_log(
    debug,
    &format!(
      "workspace discovered: member_deno_json={:?}, root_deno_json={:?}, members={:?}",
      workspace_dir.member_deno_json().map(|c| c.specifier.to_string()),
      workspace_dir
        .workspace
        .root_deno_json()
        .map(|c| c.specifier.to_string()),
      workspace_dir
        .workspace
        .config_folders()
        .keys()
        .map(|u| u.to_string())
        .collect::<Vec<_>>(),
    ),
  );

  let mut pattern = FilePatterns::new_with_base(dir_path.clone());

  if !ignore_paths.is_empty() {
    debug_log(
      debug,
      &format!("applying ignore_paths={:?}", ignore_paths),
    );
    let exclude = PathOrPatternSet::from_exclude_relative_path_or_patterns(
      &dir_path,
      &ignore_paths,
    )?;
    pattern
      .exclude
      .append(exclude.into_path_or_patterns().into_iter());
  }

  if let Some(config) = workspace_dir.to_deploy_config(pattern)? {
    debug_log(
      debug,
      &format!(
        "deploy config: include={:?}, exclude={:?}",
        config.files.include, config.files.exclude,
      ),
    );
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
    debug_log(debug, &format!("deploy config specifier={}", specifier));
    let files = if collect_files {
      collect_source_files(
        &real_sys,
        dir_path,
        config.files,
        allow_node_modules,
        debug,
      )
    } else {
      debug_log(debug, "skipping source-file collection (metadata-only lookup)");
      Vec::new()
    };
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
    debug_log(
      debug,
      &format!(
        "no deploy config found; fallback config path={:?}",
        path,
      ),
    );
    let files = if collect_files {
      collect_source_files(
        &real_sys,
        dir_path.clone(),
        FilePatterns::new_with_base(dir_path),
        allow_node_modules,
        debug,
      )
    } else {
      debug_log(debug, "skipping source-file collection (metadata-only lookup)");
      Vec::new()
    };
    Ok(ConfigLookup { path, files })
  }
}

fn collect_source_files(
  real_sys: &sys_traits::impls::RealSys,
  root_path: PathBuf,
  files: FilePatterns,
  allow_node_modules: bool,
  debug: bool,
) -> Vec<String> {
  let filter_root = root_path.clone();
  let mut collector = FileCollector::new(move |entry| {
    let kept = entry.path.starts_with(&filter_root);
    debug_log(
      debug,
      &format!(
        "walk entry path={:?} is_dir={} kept={} (root={:?})",
        entry.path,
        entry.metadata.file_type().is_dir(),
        kept,
        filter_root,
      ),
    );
    kept
  })
  .ignore_git_folder()
  .use_gitignore();

  if !allow_node_modules {
    collector = collector.ignore_node_modules();
  }

  debug_log(
    debug,
    &format!(
      "collector config: ignore_git_folder=true, use_gitignore=true, ignore_node_modules={}",
      !allow_node_modules,
    ),
  );

  let collected: Vec<String> = collector
    .collect_file_patterns(real_sys, &files)
    .into_iter()
    .map(|path| path.to_string_lossy().to_string())
    .collect();

  debug_log(
    debug,
    &format!(
      "collect_files(root_path={:?}, allow_node_modules={}, include={:?}, exclude={:?}) -> {} file(s): {:?}",
      root_path,
      allow_node_modules,
      files.include,
      files.exclude,
      collected.len(),
      collected,
    ),
  );

  collected
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

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
  use super::inner_resolve_config;
  use std::fs;
  use std::path::Path;
  use tempfile::TempDir;

  fn write_file(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
  }

  // Regression test for denoland/deno#33562: running `deno deploy` from a
  // workspace root with a top-level `deploy` config must include workspace
  // member files in the upload manifest. Before the fix this returned an
  // empty file list because members were silently appended to the exclude
  // patterns.
  #[test]
  fn workspace_root_includes_member_files() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
      root,
      "deno.json",
      r#"{
        "workspace": ["./packages/backend"],
        "deploy": { "org": "myorg", "app": "myapp" }
      }"#,
    );
    write_file(root, "packages/backend/deno.json", "{}");
    write_file(
      root,
      "packages/backend/main.ts",
      "Deno.serve(() => new Response('hello'));",
    );

    let result = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      Vec::new(),
      false,
      true,
      false,
    )
    .unwrap();

    let expected = root.join("packages/backend/main.ts");
    assert!(
      result
        .files
        .iter()
        .any(|f| Path::new(f) == expected.as_path()),
      "expected {} in deploy files; got {:?}",
      expected.display(),
      result.files,
    );
  }

  // Metadata-only lookups (collect_files=false) must resolve the deploy config
  // path (so org/app can be read) without performing any downward source-file
  // walk. This is what keeps non-publish commands from traversing /sys, /proc,
  // etc. when run from `/`.
  #[test]
  fn metadata_only_skips_file_collection() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
      root,
      "deno.json",
      r#"{ "deploy": { "org": "myorg", "app": "myapp" } }"#,
    );
    // A trap subtree that a downward walk would pick up but a metadata-only
    // lookup must ignore.
    write_file(root, "trap/sentinel.txt", "trap");
    write_file(root, "main.ts", "Deno.serve(() => new Response('hi'));");

    let metadata = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      Vec::new(),
      false,
      false,
      false,
    )
    .unwrap();

    assert!(
      metadata.path.is_some(),
      "expected the deploy config path to be resolved for metadata lookup",
    );
    assert!(
      metadata.files.is_empty(),
      "metadata-only lookup must not collect files; got {:?}",
      metadata.files,
    );

    // The same tree, collected for publish, still yields the source files.
    let collected = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      Vec::new(),
      false,
      true,
      false,
    )
    .unwrap();
    let trap = root.join("trap/sentinel.txt");
    assert!(
      collected
        .files
        .iter()
        .any(|f| Path::new(f) == trap.as_path()),
      "expected source collection to still walk the tree; got {:?}",
      collected.files,
    );
  }
}
