use deno_config::glob::FileCollector;
use deno_config::glob::FilePatterns;
use deno_config::glob::PathOrPattern;
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
  debug: bool,
) -> Result<JsValue, JsValue> {
  let result =
    inner_resolve_config(root_path, ignore_paths, allow_node_modules, debug);
  result
    .map_err(|err| create_js_error(&err))
    .map(|val| serde_wasm_bindgen::to_value(&val).unwrap())
}

fn inner_resolve_config(
  root_path: String,
  ignore_paths: Vec<String>,
  allow_node_modules: bool,
  debug: bool,
) -> Result<ConfigLookup, anyhow::Error> {
  debug_log(
    debug,
    &format!(
      "resolve_config(root_path={:?}, ignore_paths={:?}, allow_node_modules={})",
      root_path, ignore_paths, allow_node_modules
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

  if let Some(mut config) = workspace_dir.to_deploy_config(pattern)? {
    // Workaround for deno_config v0.97.0: `to_deploy_config` calls
    // `exclude_includes_with_member_for_base_for_root` which strips any
    // user-supplied `deploy.include` pattern whose base path points inside
    // a workspace member, even when that member has no competing deploy
    // config of its own. That breaks `deno deploy` from a workspace root
    // whose root deploy config includes member files (see
    // denoland/deploy-cli#90). Restore any user-listed include that was
    // stripped.
    restore_stripped_member_includes(&workspace_dir, &mut config.files, debug)?;
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

/// Restore `deploy.include` entries that
/// `WorkspaceDirectory::exclude_includes_with_member_for_base_for_root`
/// dropped because their base path falls inside a workspace member.
///
/// The upstream strip is over-eager: the user explicitly listed those paths,
/// and (in the deploy-from-workspace-root case) the workspace member typically
/// has no competing `deploy` block, so the root config is the only place those
/// files can come from. We re-add the missing entries by reading the raw
/// `deploy.include` from whichever deno.json owns the `deploy` block.
fn restore_stripped_member_includes(
  workspace_dir: &WorkspaceDirectory,
  files: &mut FilePatterns,
  debug: bool,
) -> Result<(), anyhow::Error> {
  let raw_config = workspace_dir
    .member_deno_json()
    .filter(|c| c.json.deploy.is_some())
    .map(|c| c.to_deploy_config())
    .or_else(|| {
      workspace_dir
        .workspace
        .root_deno_json()
        .filter(|c| c.json.deploy.is_some())
        .map(|c| c.to_deploy_config())
    })
    .transpose()?
    .flatten();
  let Some(raw_config) = raw_config else {
    return Ok(());
  };
  let Some(raw_include) = raw_config.files.include else {
    return Ok(());
  };

  let existing_bases: Vec<PathBuf> = files
    .include
    .as_ref()
    .map(|s| s.inner().iter().filter_map(|p| p.base_path()).collect())
    .unwrap_or_default();

  let mut to_restore: Vec<PathOrPattern> = Vec::new();
  for pattern in raw_include.into_path_or_patterns() {
    let Some(base) = pattern.base_path() else {
      // Patterns without a base_path (e.g. RemoteUrl) are never stripped by
      // the upstream function, so they must already be present; skip.
      continue;
    };
    if existing_bases.iter().any(|b| b == &base) {
      continue;
    }
    debug_log(
      debug,
      &format!(
        "restoring stripped include {:?} (base={:?})",
        pattern, base,
      ),
    );
    to_restore.push(pattern);
  }

  if to_restore.is_empty() {
    return Ok(());
  }

  let mut combined: Vec<PathOrPattern> = files
    .include
    .take()
    .map(|s| s.into_path_or_patterns())
    .unwrap_or_default();
  combined.extend(to_restore);
  files.include = Some(PathOrPatternSet::new(combined));
  Ok(())
}

fn collect_files(
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

  // Regression test for denoland/deploy-cli#90: a workspace-root
  // `deploy.include` pointing at a workspace member should include the
  // matching member files. Upstream `deno_config` 0.97 strips these
  // entries; the `restore_stripped_member_includes` patch re-adds them.
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
    write_file(root, "packages/backend/main.ts", "Deno.serve(() => new Response('hi'));");
    write_file(root, "packages/backend/extra.txt", "hello\n");

    let result = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      Vec::new(),
      false,
      false,
    )
    .unwrap();

    let main_ts = root.join("packages/backend/main.ts");
    let extra_txt = root.join("packages/backend/extra.txt");
    assert!(
      result.files.iter().any(|f| Path::new(f) == main_ts.as_path()),
      "expected {} in deploy files; got {:?}",
      main_ts.display(),
      result.files,
    );
    assert!(
      result.files.iter().any(|f| Path::new(f) == extra_txt.as_path()),
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
    write_file(root, "packages/backend/main.ts", "Deno.serve(() => new Response('hi'));");
    write_file(root, "packages/backend/extra.txt", "should-not-be-included\n");

    let result = inner_resolve_config(
      root.to_string_lossy().into_owned(),
      Vec::new(),
      false,
      false,
    )
    .unwrap();

    let main_ts = root.join("packages/backend/main.ts");
    let extra_txt = root.join("packages/backend/extra.txt");
    assert!(
      result.files.iter().any(|f| Path::new(f) == main_ts.as_path()),
      "expected {} in deploy files; got {:?}",
      main_ts.display(),
      result.files,
    );
    assert!(
      !result.files.iter().any(|f| Path::new(f) == extra_txt.as_path()),
      "did not expect {} in deploy files; got {:?}",
      extra_txt.display(),
      result.files,
    );
  }
}
