use deno_config::glob::FileCollector;
use deno_config::glob::FilePatterns;
use deno_config::glob::PathOrPatternSet;
use deno_config::workspace::WorkspaceDirectory;
use deno_config::workspace::WorkspaceDiscoverOptions;
use deno_config::workspace::WorkspaceDiscoverStart;
use serde::Serialize;
use std::path::Path;
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
  from_config: bool,
  ignore_paths: Vec<String>,
  allow_node_modules: bool,
  debug: bool,
) -> Result<JsValue, JsValue> {
  let result = inner_resolve_config(
    root_path,
    from_config,
    ignore_paths,
    allow_node_modules,
    debug,
  );
  result
    .map_err(|err| create_js_error(&err))
    .map(|val| serde_wasm_bindgen::to_value(&val).unwrap())
}

fn inner_resolve_config(
  root_path: String,
  from_config: bool,
  ignore_paths: Vec<String>,
  allow_node_modules: bool,
  debug: bool,
) -> Result<ConfigLookup, anyhow::Error> {
  debug_log(
    debug,
    &format!(
      "resolve_config(root_path={:?}, from_config={}, ignore_paths={:?}, allow_node_modules={})",
      root_path, from_config, ignore_paths, allow_node_modules
    ),
  );

  let real_sys = sys_traits::impls::RealSys;
  let root_path = resolve_absolute_path(root_path)?;
  debug_log(debug, &format!("resolved absolute root_path={:?}", root_path));

  let path_is_file = real_sys.fs_is_file(&root_path).unwrap_or(false);
  // Only `--config <file>` is parsed as a config file; a positional file root
  // is a deploy target whose config is discovered from its parent directory.
  let is_config_file = from_config && path_is_file;
  debug_log(
    debug,
    &format!(
      "path_is_file={} is_config_file={}",
      path_is_file, is_config_file
    ),
  );
  let dir_path = if path_is_file {
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
    let files =
      collect_files(&real_sys, dir_path, config.files, allow_node_modules, debug);
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
    let files = collect_files(
      &real_sys,
      dir_path.clone(),
      FilePatterns::new_with_base(dir_path),
      allow_node_modules,
      debug,
    );
    Ok(ConfigLookup { path, files })
  }
}

fn collect_files(
  real_sys: &sys_traits::impls::RealSys,
  root_path: PathBuf,
  files: FilePatterns,
  allow_node_modules: bool,
  debug: bool,
) -> Vec<String> {
  let filter_root = ensure_rooted(&root_path);
  let mut collector = FileCollector::new(move |entry| {
    let kept = ensure_rooted(&entry.path).starts_with(&filter_root);
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
    .map(|path| sys_traits::impls::wasm_path_to_str(&path).into_owned())
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

/// Coerces a path into a single rooted (leading-slash) representation so it can
/// be compared component-wise with `Path::starts_with`.
///
/// On the `wasm32` target `std::path` uses Unix semantics, so a Windows path
/// can appear either rooted (`/C:/proj/...`, as produced by
/// `resolve_absolute_path` via `wasm_string_to_path`) or unrooted
/// (`C:/proj/...`, as produced when `deploy.include` patterns are resolved by
/// `deno_config`). A rooted path and an unrooted path never satisfy
/// `starts_with`, which made the collector filter drop every included file on
/// Windows and yield an empty manifest. Normalizing both operands to the rooted
/// form fixes the comparison while leaving already-rooted (Unix) paths
/// unchanged.
fn ensure_rooted(path: &Path) -> PathBuf {
  let s = path.to_string_lossy().replace('\\', "/");
  if s.starts_with('/') {
    PathBuf::from(s)
  } else {
    PathBuf::from(format!("/{s}"))
  }
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
      false,
      Vec::new(),
      false,
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

  // Regression test for denoland/deploy-cli#107: a positional file root (e.g.
  // `deno deploy main.ts`) must not be deserialized as a config file. Config is
  // discovered from the file's parent directory and the file itself is part of
  // the upload manifest. Before the fix this errored with "Failed deserializing
  // config file" because any file path was treated as a config file.
  #[test]
  fn positional_file_root_discovers_parent_config() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
      root,
      "deno.json",
      r#"{ "deploy": { "org": "myorg", "app": "myapp" } }"#,
    );
    write_file(root, "main.ts", "Deno.serve(() => new Response('hello'));");

    let entry = root.join("main.ts");
    let result = inner_resolve_config(
      entry.to_string_lossy().into_owned(),
      false,
      Vec::new(),
      false,
      false,
    )
    .unwrap();

    let config_path = result
      .path
      .as_deref()
      .expect("expected a discovered config path");
    assert!(
      config_path.ends_with("deno.json"),
      "expected parent deno.json as config; got {}",
      config_path,
    );
    assert!(
      result
        .files
        .iter()
        .any(|f| Path::new(f) == entry.as_path()),
      "expected {} in deploy files; got {:?}",
      entry.display(),
      result.files,
    );
  }

  // A non-standard config filename passed via `--config` must still use
  // ConfigFile discovery so it is loaded directly regardless of its name.
  #[test]
  fn explicit_config_flag_uses_named_config_file() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
      root,
      "deno-staging.json",
      r#"{ "deploy": { "org": "myorg", "app": "staging" } }"#,
    );
    write_file(root, "main.ts", "Deno.serve(() => new Response('hello'));");

    let config = root.join("deno-staging.json");
    let result = inner_resolve_config(
      config.to_string_lossy().into_owned(),
      true,
      Vec::new(),
      false,
      false,
    )
    .unwrap();

    let config_path = result
      .path
      .as_deref()
      .expect("expected a discovered config path");
    assert!(
      config_path.ends_with("deno-staging.json"),
      "expected deno-staging.json as config; got {}",
      config_path,
    );
    let entry = root.join("main.ts");
    assert!(
      result
        .files
        .iter()
        .any(|f| Path::new(f) == entry.as_path()),
      "expected {} in deploy files; got {:?}",
      entry.display(),
      result.files,
    );
  }

  // Regression test for denoland/deploy-cli#123: on the wasm32 target
  // `resolve_absolute_path` yields a rooted drive path (`/C:/proj`) while
  // `deploy.include` patterns resolve to an unrooted drive path (`C:/proj`).
  // The collector filter compared them with `Path::starts_with`, which never
  // matches across those two forms, so every included file was dropped and the
  // upload manifest came back empty on Windows. `ensure_rooted` normalizes both
  // operands.
  #[test]
  fn ensure_rooted_matches_rooted_and_unrooted_windows_paths() {
    let root = super::ensure_rooted(Path::new("/C:/proj"));

    let rooted = super::ensure_rooted(Path::new("/C:/proj/dist/index.html"));
    assert!(
      rooted.starts_with(&root),
      "rooted entry {rooted:?} should be under root {root:?}",
    );

    let unrooted = super::ensure_rooted(Path::new("C:/proj/dist/index.html"));
    assert!(
      unrooted.starts_with(&root),
      "unrooted entry {unrooted:?} should be under root {root:?}",
    );

    let backslashed =
      super::ensure_rooted(Path::new(r"C:\proj\dist\index.html"));
    assert!(
      backslashed.starts_with(&root),
      "backslashed entry {backslashed:?} should be under root {root:?}",
    );

    // A sibling directory sharing a name prefix must not be treated as nested,
    // i.e. comparison stays component-wise rather than raw string prefix.
    let sibling = super::ensure_rooted(Path::new("C:/proj-other/index.html"));
    assert!(
      !sibling.starts_with(&root),
      "sibling {sibling:?} must not be under root {root:?}",
    );
  }

  // Regression test for denoland/deploy-cli#90: a workspace-root
  // `deploy.include` pointing at a workspace member must include the matching
  // member files. deno_config < 0.102 stripped these entries in
  // `to_deploy_config` (fixed upstream in denoland/deno#34788).
  #[test]
  fn workspace_root_deploy_include_targeting_member_glob() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
      root,
      "deno.json",
      r#"{
        "workspace": ["./packages/backend"],
        "deploy": {
          "org": "myorg",
          "app": "myapp",
          "include": ["./packages/backend/**"]
        }
      }"#,
    );
    write_file(root, "packages/backend/deno.json", "{}");
    write_file(
      root,
      "packages/backend/main.ts",
      "Deno.serve(() => new Response('hi'));",
    );
    write_file(root, "packages/backend/extra.txt", "hello\n");

    let result = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      false,
      Vec::new(),
      false,
      false,
    )
    .unwrap();

    let main_ts = root.join("packages/backend/main.ts");
    let extra_txt = root.join("packages/backend/extra.txt");
    assert!(
      result
        .files
        .iter()
        .any(|f| Path::new(f) == main_ts.as_path()),
      "expected {} in deploy files; got {:?}",
      main_ts.display(),
      result.files,
    );
    assert!(
      result
        .files
        .iter()
        .any(|f| Path::new(f) == extra_txt.as_path()),
      "expected {} in deploy files; got {:?}",
      extra_txt.display(),
      result.files,
    );
  }

  // Same regression but with an explicit file include rather than a glob.
  #[test]
  fn workspace_root_deploy_include_targeting_member_file() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    write_file(
      root,
      "deno.json",
      r#"{
        "workspace": ["./packages/backend"],
        "deploy": {
          "org": "myorg",
          "app": "myapp",
          "include": ["./packages/backend/main.ts"]
        }
      }"#,
    );
    write_file(root, "packages/backend/deno.json", "{}");
    write_file(
      root,
      "packages/backend/main.ts",
      "Deno.serve(() => new Response('hi'));",
    );
    write_file(root, "packages/backend/extra.txt", "should-not-be-included\n");

    let result = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      false,
      Vec::new(),
      false,
      false,
    )
    .unwrap();

    let main_ts = root.join("packages/backend/main.ts");
    let extra_txt = root.join("packages/backend/extra.txt");
    assert!(
      result
        .files
        .iter()
        .any(|f| Path::new(f) == main_ts.as_path()),
      "expected {} in deploy files; got {:?}",
      main_ts.display(),
      result.files,
    );
    assert!(
      !result
        .files
        .iter()
        .any(|f| Path::new(f) == extra_txt.as_path()),
      "did not expect {} in deploy files; got {:?}",
      extra_txt.display(),
      result.files,
    );
  }
}
