# Things


- Can we add an option that allows the user to specify in the configuration to use a given chrome or firefox browser path as the "web viewer"? I want to keep existing VSCode/VSCodium extension behavior and default native app behavior. But in the case where the dependencies are not installed or the configuration explicitly overrides, try to use an installer web browser as the viewer of our terminal emulator? Does that make sense?

- With an embedded binary in the wrapper script, can we still pass argv to the binary when it starts? Can we design the wrapper script to pass through arguments to the embedded binary?

- It looks like rustup has apple based crates. Can you use those to cross compile the macos binaries? If that is not sufficient, can you locate a docker image that already contains the Apple SDK to cross compile the macos binaries?

```sh
git push origin main:publish                              # or merge main into publish
git tag v0.1.0 origin/publish && git push origin v0.1.0
```
