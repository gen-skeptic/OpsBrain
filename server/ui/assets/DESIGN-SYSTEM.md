# Design system assets

`dautel.css`, `fonts/`, `favicon.svg` and `dautel-intelligent-operations-mark.svg` are copies of the Dautel Design System (canonical source: the `Dautel_style/` folder of gen-skeptic/dautel_brand, mirrored in gen-skeptic/experts `design-system/`). The Google Fonts `@import` is removed and the fonts are served locally, so the UI makes no outside requests. The fonts are under the SIL Open Font License (see `fonts/LICENSE-*.txt`).

Change the design system upstream first, then copy it here. `ui.css` is OpsBrain's own layer on top, using the design system's role tokens only.
