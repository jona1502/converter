# Header fixtures

Small synthetic images generated with Pillow 13.0.0. `manifest.json` records the actual decoded dimensions, format and animation state. Static images are 37×23 px, except ICO which has 16/32/64 px entries and a largest entry of 64×64 px. Animated fixtures contain two differently colored frames at 37×23 px.

These are real encoded files for Go/Python header-probe parity tests, not user data. They cover the seven required input codecs and GIF/APNG/WebP/AVIF animation rejection. They do not prove that a parser supports every legal variant of those formats; malformed and ambiguous item metadata require separate regression cases.
