// Generates vt/layout.generated.ts from the type manifest that the WASM module
// itself reports (ghostty_type_json()), so the bindings never hard-code struct
// offsets, enum values or bit positions.
//
//   node scripts/gen-vt-layout.mjs [path/to/ghostty-vt.wasm]        # write
//   node scripts/gen-vt-layout.mjs --check [path/to/ghostty-vt.wasm] # fail if stale
//
// Only the types the bindings use are emitted (listed below), to keep the
// webview bundle small. A type that is missing from the module, or a field the
// bindings rely on, fails the build: the 1.x ABI policy says that cannot
// happen, so it means the module is not the one the bindings were written for.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const wasmPath = args.find((a) => !a.startsWith('--')) ?? join(root, 'media', 'ghostty-vt.wasm');
const outPath = join(root, 'vt', 'layout.generated.ts');

const ENUMS = [
  'GhosttyResult',
  'GhosttyBuildInfo',
  'GhosttyTerminalOption',
  'GhosttyTerminalData',
  'GhosttyTerminalScreen',
  'GhosttyTerminalScrollViewportTag',
  'GhosttyTerminalBoundary',
  'GhosttyTerminalStringKind',
  'GhosttyTerminalStringEnd',
  'GhosttyTerminalCompressionMode',
  'GhosttyTerminalCompressionResult',
  'GhosttyTerminalProgressState',
  'GhosttyTerminalUnknownSequenceTag',
  'GhosttyTerminalResizeWindowTag',
  'GhosttyProgramStatusState',
  'GhosttyProgramStatusKind',
  'GhosttySemanticPromptKind',
  'GhosttySemanticPromptPromptKind',
  'GhosttyClipboardLocation',
  'GhosttyClipboardReadResult',
  'GhosttyClipboardWriteResult',
  'GhosttyColorScheme',
  'GhosttyCursorStyle',
  'GhosttyMouseShape',
  'GhosttyRenderStateData',
  'GhosttyRenderStateOption',
  'GhosttyRenderStateDirty',
  'GhosttyRenderStateRowData',
  'GhosttyRenderStateRowOption',
  'GhosttyRenderStateRowCellsData',
  'GhosttyRenderStateImageData',
  'GhosttyImageLayer',
  'GhosttyImageProtocol',
  'GhosttyCellContentTag',
  'GhosttyCellWide',
  'GhosttyStyleColorTag',
  'GhosttySgrUnderline',
  'GhosttyKey',
  'GhosttyKeyAction',
  'GhosttyKeyEncoderOption',
  'GhosttyOptionAsAlt',
  'GhosttyMouseAction',
  'GhosttyMouseButton',
  'GhosttyMouseEncoderOption',
  'GhosttyMouseTrackingMode',
  'GhosttyMouseFormat',
  'GhosttyFocusEvent',
  'GhosttyPasteSource',
  'GhosttyPointTag',
  'GhosttySelectionOrder',
  'GhosttySelectionAdjust',
  'GhosttySelectionGestureAutoscroll',
  'GhosttySelectionGestureEventType',
  'GhosttySelectionGestureEventOption',
  'GhosttySelectionGestureBehavior',
  'GhosttySelectionGestureData',
  'GhosttySearchOption',
  'GhosttySearchData',
  'GhosttySearchStatus',
  'GhosttySearchScroll',
  'GhosttyFormatterOption',
  'GhosttyFormatterFormat',
  'GhosttySnapshotDecoderOption',
  'GhosttySnapshotDecoderData',
  'GhosttySnapshotDecoderProgressKind',
  'GhosttySysOption',
  'GhosttySysLogLevel',
  'GhosttyKittyGraphicsData',
  'GhosttyKittyGraphicsImageData',
  'GhosttyKittyImageFormat',
  'GhosttyOscTerminator',
];

const STRUCTS = [
  'GhosttyString',
  'GhosttyBuffer',
  'GhosttyCodepointBuffer',
  'GhosttySelectionBuffer',
  'GhosttyColorRgb',
  'GhosttyStyle',
  'GhosttyStyleColor',
  'GhosttyTerminalScrollViewport',
  'GhosttyTerminalScrollbar',
  'GhosttyTerminalWriteStop',
  'GhosttyTerminalModeConfig',
  'GhosttyTerminalMemoryUsage',
  'GhosttyTerminalUnknownSequence',
  'GhosttyTerminalUnknownOscSequence',
  'GhosttyTerminalUnknownStringSequence',
  'GhosttyTerminalResizeWindow',
  'GhosttyTerminalResizeWindowGrid',
  'GhosttyTerminalDesktopNotification',
  'GhosttyTerminalProgressReport',
  'GhosttyTerminalProgramStatus',
  'GhosttyTerminalSemanticPrompt',
  'GhosttyTerminalSelectWordOptions',
  'GhosttyTerminalSelectLineOptions',
  'GhosttyTerminalSelectWordBetweenOptions',
  'GhosttyCodepoints',
  'GhosttyClipboardContent',
  'GhosttyClipboardWrite',
  'GhosttyClipboardWriteReply',
  'GhosttyClipboardRead',
  'GhosttyClipboardReadReply',
  'GhosttyDeviceAttributes',
  'GhosttyDeviceAttributesPrimary',
  'GhosttyDeviceAttributesSecondary',
  'GhosttyDeviceAttributesTertiary',
  'GhosttySizeReportSize',
  'GhosttyRenderStateColors',
  'GhosttyRenderStateCursor',
  'GhosttyRenderStateRowSelection',
  'GhosttyRenderStateRowId',
  'GhosttyCellsView',
  'GhosttyGridRef',
  'GhosttyPoint',
  'GhosttyPointCoordinate',
  'GhosttySelection',
  'GhosttySelectionGestureGeometry',
  'GhosttySelectionGestureBehaviors',
  'GhosttySurfacePosition',
  'GhosttyMouseEncoderSize',
  'GhosttyMousePosition',
  'GhosttyPaste',
  'GhosttyMimeReader',
  'GhosttyWriter',
  'GhosttyReader',
  'GhosttySysImage',
  'GhosttyKittyGraphicsPlacementRenderInfo',
];

const PACKED = ['GhosttyCell', 'GhosttyStyleFlags'];

// Fields the bindings read or write. A struct may gain trailing fields in a
// minor release; it may never lose or move these.
const REQUIRED_FIELDS = {
  GhosttyStyle: ['fg_color', 'bg_color', 'underline_color', 'flags'],
  GhosttyRenderStateCursor: ['size', 'viewport_has_value', 'viewport_x', 'viewport_y', 'wide_tail', 'visible', 'blinking', 'password_input', 'visual_style'],
  GhosttyRenderStateColors: ['size', 'background', 'foreground', 'cursor', 'cursor_has_value', 'palette'],
  GhosttyClipboardWrite: ['location', 'contents', 'contents_len', 'name', 'granted', 'can_remember', 'reply'],
  GhosttyClipboardRead: ['location', 'mimes', 'mimes_len', 'list', 'name', 'granted', 'can_remember', 'reply'],
};

function loadManifest(path) {
  const mod = new WebAssembly.Module(readFileSync(path));
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    // A WASI build imports a handful of functions; none run during
    // ghostty_type_json(), so stubs are enough here.
    (imports[imp.module] ??= {})[imp.name] = () => 0;
  }
  const inst = new WebAssembly.Instance(mod, imports);
  const ex = inst.exports;
  const ptr = ex.ghostty_type_json();
  const u8 = new Uint8Array(ex.memory.buffer);
  let end = ptr;
  while (u8[end]) end++;
  return JSON.parse(new TextDecoder().decode(u8.subarray(ptr, end)));
}

function fail(msg) {
  console.error(`gen-vt-layout: ${msg}`);
  process.exit(1);
}

const m = loadManifest(wasmPath);
if (m.schema !== 1) fail(`unknown manifest schema ${m.schema}`);
if (m.abi.pointer_size !== 4 || m.abi.endian !== 'little') fail(`unexpected ABI ${JSON.stringify(m.abi)}`);

const out = { version: m.library_version, abi: m.abi, enums: {}, structs: {}, packed: {} };
for (const name of ENUMS) {
  const t = m.types[name];
  if (!t || t.kind !== 'enum') fail(`enum ${name} missing`);
  out.enums[name] = Object.fromEntries(Object.entries(t.values).filter(([k]) => !k.endsWith('MAX_VALUE')));
}
for (const name of STRUCTS) {
  const t = m.types[name];
  if (!t || (t.kind !== 'struct' && t.kind !== 'union')) fail(`struct ${name} missing`);
  out.structs[name] = { size: t.size, f: Object.fromEntries(Object.entries(t.fields).map(([k, f]) => [k, f.offset])) };
  for (const req of REQUIRED_FIELDS[name] ?? []) if (!(req in t.fields)) fail(`${name}.${req} missing`);
}
// Union arms the bindings fill by hand.
out.structs.GhosttyPointValue = { size: m.types.GhosttyPointValue.size, f: { coordinate: 0 } };

function flattenPacked(bits, base = 0, prefix = '') {
  const res = {};
  for (const [k, b] of Object.entries(bits)) {
    if (b.kind === 'union' && b.arms) {
      // Every arm of a tagged packed union starts at the same lsb.
      res[prefix + k] = [base + b.lsb, b.width];
      for (const [arm, layout] of Object.entries(b.arms)) {
        if (layout?.bits) Object.assign(res, flattenPacked(layout.bits, base + b.lsb, `${prefix}${k}.${arm}.`));
      }
    } else {
      res[prefix + k] = [base + b.lsb, b.width];
    }
  }
  return res;
}
for (const name of PACKED) {
  const t = m.types[name];
  if (!t || t.kind !== 'packed') fail(`packed ${name} missing`);
  out.packed[name] = { size: t.size, bits: flattenPacked(t.bits) };
}

const text = `// Generated by scripts/gen-vt-layout.mjs from ghostty_type_json() of
// libghostty-vt ${m.library_version} (${m.abi.target}-${m.abi.os}). Do not edit.

export const LAYOUT = ${JSON.stringify(out, null, 1)} as const;
`;

if (check) {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== text) fail(`${outPath} is stale; run node scripts/gen-vt-layout.mjs`);
  console.log(`layout up to date for libghostty-vt ${m.library_version}`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath} for libghostty-vt ${m.library_version}`);
}
