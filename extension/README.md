# code-gty: Ghostty Terminal

A terminal that opens as an editor tab and uses [Ghostty](https://ghostty.org)'s terminal emulation through [libghostty-vt](https://ghostty.org/docs), Ghostty's own terminal library, compiled to WebAssembly. Because each terminal is an editor tab, you can drag it, split it, dock it next to code or pop it out into its own window.

It runs on desktop VS Code, Remote SSH, WSL, Dev Containers, Codespaces, and server-hosted editors such as code-server and Coder. It does not run in vscode.dev or github.dev without a remote, because those cannot start a shell.

## Getting started

- **Ghostty: New Terminal** (`Ctrl+Alt+\``) opens a terminal in the current editor group.
- **Ghostty: New Terminal to the Side** opens one beside it, in the same directory.
- Drag the tab anywhere, or right-click it and choose **Move into New Window**.

The terminal follows your `terminal.integrated.*` settings: default profile, font size, line height, letter spacing, font weights, cursor style and width, scrollback, environment, copy on selection, right-click behaviour (including `selectWord`), word separators, minimum contrast ratio, bold text in bright colours, custom glyphs, multi-line paste warning, bell, `confirmOnKill` and so on. It also uses your colour theme's terminal colours, and changes with it without losing anything on screen.

## What programs can do

The terminal speaks the same protocols as Ghostty itself:

- **Queries** get exact answers: device attributes, XTVERSION (`code-gty <version> (libghostty-vt <version>)`), colour queries (OSC 4/10/11/12) with your theme's colours, mode reports (including synchronized output, mode 2026), size reports, the colour scheme (mode 2031, also reported when you switch theme).
- **The Kitty keyboard protocol**, so editors such as Neovim, Helix and Kakoune can tell every key and modifier apart (`codeGty.kittyKeyboard` turns it off).
- **Images** with the Kitty graphics protocol (`kitty +kitten icat`, `chafa -f kitty`, yazi, ...), including Unicode placeholders inside tmux; **sixel** (`img2sixel`, `chafa -f sixel`, ImageMagick's `sixel:-`); and **iTerm2 inline images** (`imgcat`, OSC 1337 `File=`, also the multipart form) in PNG, JPEG, GIF (animated), WebP, BMP, ICO, TIFF, TGA, PNM and QOI. Sixel and iTerm2 images are decoded by the extension's native helper and shown through the same Kitty graphics engine (`codeGty.images`). AVIF, HEIC and SVG are not supported.
- **Synchronized output**, so full-screen programs never show half-drawn frames.
- **Mouse reporting** in every format (X10, UTF-8, SGR, URxvt, SGR pixels), focus reporting, bracketed paste and Kitty paste events.
- **Notifications** (OSC 9, OSC 777) as VS Code notifications when the tab is not focused (`codeGty.notifications`), **progress** (OSC 9;4) in the status bar and tab title (`codeGty.progress`), and **program status** (OSC 7501, used by build tools and coding agents) in the status bar.
- **The clipboard** through OSC 52 and the Kitty clipboard protocol, as `codeGty.osc52` allows.

## Keyboard

Keys go to the shell exactly as in VS Code's own terminal: only shortcuts whose default command is in VS Code's `commandsToSkipShell` list go to the workbench (Quick Open `Ctrl+P`, the Command Palette, `F1`, the terminal and panel toggles, `Ctrl+Tab`, `Ctrl+PageUp`/`PageDown`, `Ctrl+1`–`8`, `F6`, `F11`, zoom). Everything else, including `Ctrl+B` for tmux and Emacs-style keys, reaches the program.

While a full-screen program such as Neovim, tmux, htop or less is running, it gets almost every key, `Ctrl+P`, `Ctrl+F`, `Ctrl+K`, `Ctrl+J`, `Ctrl+Tab` and `Ctrl+W` included. Only the Command Palette, `F1`, your own `codeGty.passThroughKeys` and the `Ctrl+Shift+C`/`Ctrl+Shift+V` clipboard keys still go to VS Code. Turn this off with `codeGty.keysToFullScreenPrograms`. With `terminal.integrated.sendKeybindingsToShell` on, almost every key goes to the shell at the prompt too.

VS Code does not let extensions read your keybindings, so if you have custom shortcuts that should work while the terminal has focus, add them to `codeGty.passThroughKeys` (for example `"ctrl+shift+o"`). For keys the shell should always get, use `codeGty.shellKeys`.

| Action | Linux and Windows | macOS |
| --- | --- | --- |
| Copy | `Ctrl+Shift+C` (Windows: also `Ctrl+C` with a selection) | `Cmd+C` |
| Paste | `Ctrl+Shift+V`, `Shift+Insert` (Windows: also `Ctrl+V`) | `Cmd+V` |
| Find | `Ctrl+F` | `Cmd+F` |
| Previous or next command | `Ctrl+Up`, `Ctrl+Down` | `Cmd+Up`, `Cmd+Down` |
| Clear | Command Palette | `Cmd+K` |
| Scroll a page | `Shift+PageUp`, `Shift+PageDown` | `Shift+PageUp`, `Shift+PageDown` |

## Shell integration

For bash, zsh, fish and PowerShell, code-gty loads a small script through the shell's normal startup files. The script reports prompts, commands, exit codes and the current directory. That information powers "scroll to previous/next command", new terminals in the same directory, file links relative to the right directory, and restoring tabs after a reload. Turn it off with `terminal.integrated.shellIntegration.enabled`.

## Links

Ctrl+click (Cmd+click on macOS) opens:

- web links, through VS Code, so `localhost` links are forwarded when you work remotely;
- file paths such as `src/main.rs:10:5`, at the given line and column.
- OSC 8 hyperlinks (text that a program marks as a link, as `ls --hyperlink`, `gcc` and `systemctl` do), to the URL or file they point at.

## Settings

| Setting | Purpose |
| --- | --- |
| `codeGty.passThroughKeys` | Extra keys that go to the workbench instead of the shell |
| `codeGty.shellKeys` | Keys that always go to the shell |
| `codeGty.keysToFullScreenPrograms` | Full-screen programs (Neovim, tmux, ...) get workbench keys too (default on) |
| `codeGty.env` | Extra environment variables (`null` removes one) |
| `codeGty.fontFamily` | Terminal font (default: bundled IosevkaTerm Nerd Font Mono; `null` follows `terminal.integrated.fontFamily`) |
| `codeGty.fontSize` | Override the terminal font size for this extension only |
| `codeGty.colors` | Override individual theme colours |
| `codeGty.osc52` | Whether programs may set (`write`) or also read (`readWrite`) the clipboard |
| `codeGty.notifications` | Program notifications: `off`, `unfocused` (default) or `always` |
| `codeGty.progress` | Show program progress in the status bar and tab title (default on) |
| `codeGty.kittyKeyboard` | Allow the Kitty keyboard protocol (default on) |
| `codeGty.images` | Show Kitty graphics images (default on) |
| `codeGty.answerback` | Reply to ENQ (default empty) |
| `codeGty.term` | Value of `TERM` (default `xterm-256color`) |
| `codeGty.retainContextWhenHidden` | Keep background tabs alive in memory (default on; off saves memory and redraws the tab exactly when shown) |
| `codeGty.flowControlWindow`, `codeGty.replayBufferSize` | Output tuning |

### Fonts

The extension bundles the complete **IosevkaTerm Nerd Font Mono** (regular, bold, italic, bold italic), the default, so it works the same in VS Code, VSCodium and code-server (including in the browser) without installing anything. Every glyph is included, the Nerd Font icons too, and each icon is sized to one cell. The glyphs are exactly half an em wide, so at even font sizes the cells line up on whole pixels with no extra spacing.

Box drawing (U+2500–257F), block elements (U+2580–259F), Braille (U+2800–28FF), sextants (U+1FB00–1FB3B) and Powerline separators (U+E0B0–E0BF, including the rounded arches) are drawn as shapes that exactly fill their cell, as native Ghostty and VS Code's own terminal do, so they line up with neighbouring cell backgrounds at any font, size or display scale. `terminal.integrated.customGlyphs: false` uses the font's glyphs instead.

Set `"codeGty.fontFamily": null` to use `terminal.integrated.fontFamily` instead, or name any other font. For Nerd Font icons with another font, use its *Nerd Font Mono* build: the canvas renderer draws each glyph at the font's own size, so icons only fit their cell when they come from the same font as the text.

Fonts installed on your machine also work in desktop VS Code and VSCodium. In code-server, only fonts on the machine running the browser can be used.

### Built-in settings that are not supported yet

- Middle-click paste and the Linux primary selection.
- `terminal.integrated.gpuAcceleration`: the terminal draws with canvas 2D.

## Known limitations

This terminal is a webview, not a VS Code terminal, so:

- it does not appear in the terminal panel's list or in `window.terminals`, and the Tasks system and debugger cannot use it;
- other extensions' terminal link providers, quick fixes and environment contributions (for example the git extension's askpass helper) do not apply. Extensions can use this extension's own API instead (below);
- **Terminal: Run Selected Text** targets the built-in terminal. Use **Ghostty: Run Selected Text in Active Ghostty Terminal** (`Ctrl+Alt+Enter`) instead;
- in a browser (code-server, Coder), keys the browser keeps for itself, such as `Ctrl+W`, cannot be captured;
- a window reload restarts the shell, in the same directory, with a divider line. (Moving a tab, or a hidden tab coming back, keeps everything: the screen is restored exactly from the terminal engine in the extension host.) Sessions that survive a reload are planned. In browser-hosted editors the directory is saved lazily, so a `cd` made in the last few seconds before a reload can be lost;
- browser-hosted editors must be served over HTTPS or from `localhost`. Over plain HTTP from another host, VS Code disables all webviews, including this terminal;
- screen-reader support is basic: a live region of the visible screen when `editor.accessibilitySupport` is `on`, and **Ghostty: Show Recent Output (Accessible)**.

## API for other extensions

```ts
const api = vscode.extensions.getExtension('code-gty.code-gty')?.exports;
const term = api.createTerminal({ name: 'build', cwd: '/work', env: { CI: '1' } });
term.sendText('make');
const off = api.contributeEnvironment('my-extension', { MY_TOOL_SOCKET: '/tmp/s' });

term.readScreen();           // the visible screen as text
await term.readOutput(200);  // the last 200 lines of screen and scrollback
term.lastCommandOutput();    // output of the last command (needs shell integration)
term.lastExitCode;           // its exit code

// Sequences the terminal does not implement, for your own protocols:
api.onDidReceiveSequence(({ terminal, id, content }) => {
  if (id === '7400') console.log(new TextDecoder().decode(content)); // ESC ] 7400 ; ... ST
});
```

The commands `codeGty.sendText` (`{ text, addNewLine }`) and `codeGty.new` can also be called with `vscode.commands.executeCommand`.

## Privacy

code-gty collects no telemetry.
