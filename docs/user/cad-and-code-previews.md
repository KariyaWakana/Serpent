# CAD and code asset previews

DXF drawings open in a local, read-only model-space viewer. Use the mouse wheel
to zoom, drag to pan, **Fit drawing** to restore the complete extent, and the
layer checkboxes to show or hide geometry. Parsing runs in a dedicated web worker;
closing the viewer terminates that work. Processing is stopped after 60 seconds.
DXF cards currently use a generic icon rather than a generated thumbnail.

The preview uses `dxf-viewer` 1.0.49. It is a browsing aid: line weights, line
patterns, layouts, external references, some dimensions and unsupported entities
may differ from CAD output. DejaVu Sans provides fallback text; CJK/SHX glyphs may
be missing. The original file remains the drawing authority. Faraway geometry can
make the main drawing small when fitting the complete extent; zoom into the area
of interest.

DWG opens through a separate, locally installed LibreDWG `dwg2dxf` executable.
The library worker converts a temporary copy to DXF and caches a read-only viewer
representation against the source revision and converter fingerprint. Opening
again reuses that cache; source revision changes or converter updates regenerate
it. Conversion never overwrites or moves the DWG. Hover and off-screen preloading
do not start conversion. No drawing is uploaded. CAD cards retain generic icons.

Install the independent tool from [LibreDWG's official releases](https://github.com/LibreDWG/libredwg/releases),
preserving its runtime DLLs and license documentation. Set
`SERPENT_DWG_CONVERTER_PATH` to the absolute `dwg2dxf` path before starting Serpent.
Alternatively place the independent installation at
`resources/cad-tools/libredwg/dwg2dxf.exe` next to the packaged `app.asar`
(macOS: `Contents/Resources/cad-tools/libredwg/dwg2dxf`), or install it on PATH.
Development builds also check `local-tools/libredwg/`. The executable is optional
and is not included as a linked dependency in the MIT application or repository.
LibreDWG is separately licensed under GPL-3.0-or-later; preserve its notices and
source information when distributing the independent tool.

Conversions are serialized and limited to 90 seconds; the source and resulting
DXF each have a 256 MiB preview limit. Closing a viewer abandons presentation;
an already running conversion can finish and populate its cache. LibreDWG's DWG
coverage and the DXF viewer's rendering coverage both apply. This is a model-space
browsing aid, with no DWG editing, paper-space layout rendering, or automatic
external-reference and SHX/CJK font resolution. Conversion errors appear inside
Serpent with an external-open action, rather than a Windows warning dialog.

Code assets open with line numbers, explicit language highlighting, literal search
and a separate **Edit source** action for supported managed files. `.mjs`, `.cjs`
and Grasshopper `.ghx` are recognized alongside Python, C#, JavaScript, TypeScript,
XML, JSON and existing text formats. Code is never executed by the preview.
GHX is shown as read-only XML, not a Grasshopper canvas. Binary `.gh` and compiled
`.gha` are not treated as text source.

Text loading is capped at 1 MiB. Truncated files, linked assets and GHX definitions
cannot be saved through the text editor. Files larger than 100,000 characters use
plain selectable text instead of syntax highlighting to keep browsing responsive.
Existing source editing and revision behavior is retained for editable assets.
