pub(crate) use orbiterx_skills::install_system_skills;
pub(crate) use orbiterx_skills::system_cache_root_dir;

use orbiterx_utils_absolute_path::AbsolutePathBuf;

pub(crate) fn uninstall_system_skills(orbiterx_home: &AbsolutePathBuf) {
    let _ = std::fs::remove_dir_all(system_cache_root_dir(orbiterx_home));
}
