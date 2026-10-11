"""Expose host build tools discovered on PATH to Cargo build scripts."""

def _native_build_tools_impl(rctx):
    for tool in ["cmake", "ninja"]:
        executable = rctx.which(tool)
        if executable == None:
            fail("Native build requires %s on PATH" % tool)
        rctx.symlink(executable, tool)
    rctx.file("BUILD.bazel", """\
package(default_visibility = ["//visibility:public"])
exports_files(["cmake", "ninja"])
""")

native_build_tools_repository = repository_rule(
    implementation = _native_build_tools_impl,
    environ = ["PATH"],
    local = True,
    configure = True,
)
