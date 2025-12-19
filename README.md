# <img src="icon.svg" width="24" alt="ImmoNoise Logo"> ImmoNoise - Noise Pollution | Chrome Extension

ImmoNoise is a Google Chrome extension that displays road, rail, and overall noise pollution levels directly on **ImmobilienScout24** property expose pages. Specifically designed for **Berlin**, it provides users with crucial environmental data before they even visit a property.

![ImmoNoise Preview](preview.png)

### Key Features

- **Hybrid Fetching Architecture**: Uses a Cloudflare Worker for speed and caching, with a seamless client-side fallback to direct APIs if the proxy is unavailable.
- **Multi-Source Noise Data**: Displays Road Traffic, Tram/U-Bahn, and Sum of All Traffic Sources.
- **Smart City Detection**: Automatically detects the city via JSON-LD schema (currently optimized for Berlin).
- **Proactive UI**: Shows "Coming soon" for properties outside Berlin to manage expectations.
- **Accurate Color Coding**:
  - 🌲 **Dark Green**: bis 55 dB(A) (Quiet)
  - 🟢 **Green**: 55 - 59 dB(A)
  - 🟡 **Yellow**: 59 - 64 dB(A)
  - 🔴 **Red**: 64 - 69 dB(A)
  - 🟣 **Purple**: 69 - 74 dB(A) (Loud)
- **Edge Caching**: Data is cached for 30 days at the edge, reducing total requests to `berlin.de` by ~90%.
- **Premium Design**: Modern glassmorphism UI with smooth animations and an animated wave logo.

## Installation (Developer Mode)

1. **Download/Clone** this repository to your local machine.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right corner).
4. Click **Load unpacked**.
5. Select the `ImmoNoise` folder where the `manifest.json` is located.
6. Visit any ImmobilienScout24 Expose page in Berlin.

## Architecture

ImmoNoise uses a **Worker-first** approach:
1. **Primary**: Fetch from `api-immonoise.martinaberastegue.com` (Cloudflare Worker).
2. **Cache**: Results are cached for 30 days to ensure sub-100ms response times.
3. **Fallback**: If the Worker is unreachable or blocked, the extension automatically performs the 4-step fetching process directly from the user's browser.

```mermaid
graph TD
    A[Detect Address] --> B{Try Cloudflare Worker}
    B -- "Success (Cached/New)" --> C[Update UI]
    B -- "Failure (Blocked/Down)" --> D[Direct Fetch: Berlin GDI]
    D --> E[Geosearch API]
    E --> F[WMS GetFeatureInfo x3]
    F --> C
```

## Technical Details

- **Manifest V3**: Compliant with the latest Chrome extension standards.
- **Worker Proxy**: Built with Cloudflare Workers to aggregate and normalize WMS data.
- **APIs Used**:
  - [Berlin GDI Geosearch](https://gdi.berlin.de/searches/bkg/geosearch)
  - [Berlin GDI WMS (Umweltatlas 2022)](https://gdi.berlin.de/services/wms/ua_stratlaerm_2022)
- **City Detection**: Parses `application/ld+json` schema for reliable `addressLocality` identification.

## License

MIT License - feel free to use and modify for your own projects!
