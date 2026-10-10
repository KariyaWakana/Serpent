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
of interest. DWG is not decoded by this viewer: use **Open with external app**, or
export an associated DXF/PDF from your CAD application.

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
