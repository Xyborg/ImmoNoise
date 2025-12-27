/**
 * ImmoNoise Content Script
 */

(async () => {
    let currentAddress = null;
    let badgeElement = null;

    // Final custom domain for your Worker
    const WORKER_URL = 'https://api-immonoise.martinaberastegue.com';

    // Map the three layers we query. Reused for proxy fallback.
    const LAYER_NAMES = {
        road: 'bb_strasse_gesamt_den2022',
        rail: 'bc_tram_ubahn_den2022',
        total: 'bf_gesamtlaerm_den2022'
    };

    const hasUsableValue = (value) => typeof value === 'string' && /\d+/.test(value);
    const logDebug = (..._args) => {};

    function getIS24Data() {
        try {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                // Look for the script containing locationAddress
                if (s.innerText.includes('locationAddress:')) {
                    const text = s.innerText;

                    // Use regex that handles both "Value" and undefined (without quotes)
                    const extract = (key) => {
                        const m = text.match(new RegExp(`${key}:\\s*(?:"(.*?)"|undefined|([^,\\s}]*))`));
                        if (!m) return null;
                        const val = m[1] || m[2];
                        return val === 'undefined' ? null : val;
                    };

                    const city = extract('city');
                    const zip = extract('zip');
                    const street = extract('street');
                    const houseNumber = extract('houseNumber');
                    const isFullAddress = text.match(/isFullAddress:\s*(true|false)/)?.[1] === 'true';

                    if (city || zip) {
                        return { city, zip, street, houseNumber, isFullAddress };
                    }
                }
            }
        } catch (e) {
            logDebug("ImmoNoise: Error extracting IS24 data", e);
        }
        return null;
    }

    function detectCity() {
        // First try the high-quality script data
        const is24Data = getIS24Data();
        if (is24Data?.city) return is24Data.city;

        try {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                const json = JSON.parse(script.innerText);
                const graph = json['@graph'] || [json];

                for (const item of graph) {
                    if (item['@type'] === 'RealEstateListing' && item.address?.addressLocality) {
                        return item.address.addressLocality;
                    }
                    if (item['@type'] === 'PostalAddress' && item.addressLocality) {
                        return item.addressLocality;
                    }
                }
            }
        } catch (e) {
            logDebug("ImmoNoise: Error detecting city", e);
        }
        return null;
    }

    function normalizeAddressText(text) {
        if (!text) return null;
        const cleaned = text
            .replace(/\s+/g, ' ')
            .replace(/\s*,\s*/g, ', ')
            .replace(/,\s*,/g, ', ')
            .replace(/,\s*$/, '')
            .trim();
        return cleaned || null;
    }

    function ensureCityInAddress(address, cityName) {
        if (!address || !cityName) return address;
        const cityRegex = new RegExp(`\\b${cityName}\\b`, 'i');
        if (!cityRegex.test(address)) {
            return `${address}, ${cityName}`;
        }
        return address;
    }

    function getLivingInBerlinAddress() {
        try {
            const xpath = '/html/body/div[1]/div/div[5]/div[2]/dl/dd[2]';
            const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            const text = node?.textContent;
            if (text) {
                return normalizeAddressText(text);
            }
        } catch (e) {
            logDebug("ImmoNoise: Error extracting LivingInBerlin address", e);
        }
        return null;
    }

    function getUrbanGroundAddress() {
        try {
            const bySelector = document.querySelector('a.map-location');
            const text = bySelector?.textContent;
            if (text) return normalizeAddressText(text);

            const xpath = '/html/body/app-root/app-property-details-page/section/div[1]/div[1]/div/div[2]/small/a';
            const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            const text2 = node?.textContent;
            if (text2) return normalizeAddressText(text2);
        } catch (e) {
            logDebug("ImmoNoise: Error extracting UrbanGround address", e);
        }
        return null;
    }

    async function geosearchCenterWgs84(address) {
        try {
            const encodedAddress = encodeURIComponent(address);
            // Rough WGS84 bbox covering Berlin
            const berlinBBox4326 = "13.0,52.3,13.9,52.7";
            const url =
                `https://gdi.berlin.de/searches/bkg/geosearch?` +
                `bbox=${berlinBBox4326}&outputformat=json&srsName=EPSG:4326&count=1&query=${encodedAddress}`;

            const geo = await fetch(url, {
                headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
            }).then(r => r.json());

            const coords = geo.features?.[0]?.geometry?.coordinates;
            if (!coords || coords.length < 2) return null;
            return { lat: coords[1], lon: coords[0] };
        } catch (e) {
            logDebug("ImmoNoise: geosearchCenterWgs84 failed", e);
            return null;
        }
    }

    function buildSyntheticGrid(center, noise) {
        if (!center) return null;
        const latDelta = (10.1 / 111132); // ~10m north/south
        const lonDelta = (10.1 / (111132 * Math.cos(center.lat * (Math.PI / 180)))); // ~10m east/west adjusted for latitude
        const offsets = [-1, 0, 1];
        const cells = [];
        offsets.forEach(dy => {
            offsets.forEach(dx => {
                cells.push({
                    center_wgs84: {
                        lat: center.lat + dy * latDelta,
                        lon: center.lon + dx * lonDelta
                    },
                    noise: {
                        total: noise.total,
                        road: noise.road,
                        rail: noise.rail
                    }
                });
            });
        });
        return {
            center_wgs84: center,
            surroundings: { grid3x3: cells }
        };
    }

    function createBadge(results, cityMessage = null) {
        if (badgeElement) {
            badgeElement.remove();
        }

        // Reset Map State to ensure clean slate
        if (map) {
            map.remove();
            map = null;
        }
        mapInitialized = false;

        badgeElement = document.createElement('div');
        badgeElement.className = 'immo-noise-badge';

        // Header
        const headerEl = document.createElement('div');
        headerEl.className = 'immo-noise-header';

        const logoImg = document.createElement('img');
        logoImg.src = chrome.runtime.getURL('wave.gif');
        logoImg.className = 'immo-noise-logo';

        const titleEl = document.createElement('div');
        titleEl.className = 'immo-noise-title';
        titleEl.innerText = 'ImmoNoise';

        headerEl.appendChild(logoImg);
        headerEl.appendChild(titleEl);
        badgeElement.appendChild(headerEl);

        // Body
        const bodyEl = document.createElement('div');
        bodyEl.className = 'immo-noise-body';

        if (cityMessage) {
            const msgEl = document.createElement('div');
            msgEl.className = 'immo-noise-upcoming';
            msgEl.innerText = cityMessage;
            bodyEl.appendChild(msgEl);
        } else {
            results.forEach(res => {
                const entryEl = document.createElement('div');
                entryEl.className = 'immo-noise-entry';

                // Category label (small, at top)
                const categoryEl = document.createElement('div');
                categoryEl.className = 'immo-noise-category';
                categoryEl.innerText = res.label;

                if (res.error || !hasUsableValue(res.value)) {
                    const errorEl = document.createElement('div');
                    errorEl.className = 'immo-noise-context-label';
                    errorEl.innerText = 'N/A';
                    errorEl.style.color = '#ccc';
                    entryEl.title = res.error || 'Noise value unavailable';
                    entryEl.appendChild(categoryEl);
                    entryEl.appendChild(errorEl);
                } else {
                    // Extract max dB for classification
                    const numbers = res.value.match(/\d+/g);
                    if (numbers && numbers.length > 0) {
                        const maxVal = Math.max(...numbers.map(Number));
                        const context = getNoiseContext(maxVal);

                        // Context label (main, large)
                        const contextEl = document.createElement('div');
                        contextEl.className = 'immo-noise-context-label';
                        contextEl.innerText = context.label;

                        // Apply color class
                        if (maxVal <= 55) {
                            contextEl.classList.add('immo-noise-level-none');
                        } else if (maxVal <= 59) {
                            contextEl.classList.add('immo-noise-level-low');
                        } else if (maxVal <= 64) {
                            contextEl.classList.add('immo-noise-level-mid');
                        } else if (maxVal <= 69) {
                            contextEl.classList.add('immo-noise-level-high');
                        } else {
                            contextEl.classList.add('immo-noise-level-extreme');
                        }

                        // dB value (small, below)
                        const dbEl = document.createElement('div');
                        dbEl.className = 'immo-noise-db-value';
                        dbEl.innerText = res.value;

                        // Tooltip on hover
                        entryEl.title = context.tooltip;

                        entryEl.appendChild(categoryEl);
                        entryEl.appendChild(contextEl);
                        entryEl.appendChild(dbEl);
                    }
                }

                bodyEl.appendChild(entryEl);
            });
        }

        badgeElement.appendChild(bodyEl);

        // Map Container
        const mapEl = document.createElement('div');
        mapEl.id = 'immo-noise-map';
        badgeElement.appendChild(mapEl);

        // Info Section (Layman Explanation + Links)
        const infoEl = document.createElement('div');
        infoEl.className = 'immo-noise-info';
        infoEl.innerHTML = `
            <p><strong>How it works:</strong> We use the address data found in this listing to fetch high-precision noise maps from the <a href="https://www.berlin.de/umweltatlas/en/traffic-noise/noise-pollution/" target="_blank" rel="noopener noreferrer"><strong>Berlin Environmental Atlas</strong></a> <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-left: 2px;"><rect width="256" height="256" fill="none"/><polyline points="216 104 215.99 40.01 152 40" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="136" y1="120" x2="216" y2="40" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><path d="M184,136v72a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8h72" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>.</p>
            <p>This shows you the expected noise from road traffic and trains at this exact location, helping you understand the environment before you step inside.</p>
            
            <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.06);">
                <div style="margin-bottom: 6px; font-weight: 600; opacity: 0.9;">Useful Links</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <a href="https://pdfprotect.io" title="Watermark PDFs. Protect your documents during your application process." target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: #333; background: rgba(0,0,0,0.03); padding: 6px 10px; border-radius: 6px; display: flex; align-items: center; gap: 6px; transition: background 0.2s;">
                        <span style="opacity: 0.5;">🔒</span> Watermark PDFs
                    </a>
                    <a href="https://allaboutberlin.com/guides/moving-to-berlin" title="Moving to Berlin" target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: #333; background: rgba(0,0,0,0.03); padding: 6px 10px; border-radius: 6px; display: flex; align-items: center; gap: 6px; transition: background 0.2s;">
                        <span style="opacity: 0.5;">📦</span> Moving to Berlin
                    </a>
                    <a href="https://allaboutberlin.com/guides/find-a-flat-in-berlin" title="Find a Flat in Berlin" target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: #333; background: rgba(0,0,0,0.03); padding: 6px 10px; border-radius: 6px; display: flex; align-items: center; gap: 6px; transition: background 0.2s;">
                        <span style="opacity: 0.5;">🏠</span> Find a Flat in Berlin
                    </a>
                    <a href="https://allaboutberlin.com/guides/housing-scams" title="Housing Scams" target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: #333; background: rgba(0,0,0,0.03); padding: 6px 10px; border-radius: 6px; display: flex; align-items: center; gap: 6px; transition: background 0.2s;">
                        <span style="opacity: 0.5;">⚠️</span> Housing Scams
                    </a>
                </div>
            </div>
        `;
        badgeElement.appendChild(infoEl);

        // Footer (About this toggle)
        const footerEl = document.createElement('div');
        footerEl.className = 'immo-noise-footer';

        const aboutToggle = document.createElement('button');
        aboutToggle.className = 'immo-noise-toggle';
        aboutToggle.innerText = 'More Details';
        // Use addEventListener for better reliability
        aboutToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            badgeElement.classList.toggle('is-expanded');
            aboutToggle.innerText = badgeElement.classList.contains('is-expanded') ? 'Close' : 'More Details';
            // (Re)initialize map on expand to ensure correct sizing & data
            if (badgeElement.classList.contains('is-expanded')) {
                // give CSS a tick to apply height, then init/invalidate
                setTimeout(() => {
                    initMap(currentWorkerData);
                    if (map) map.invalidateSize();
                }, 60);
            }
        });

        footerEl.appendChild(aboutToggle);
        badgeElement.appendChild(footerEl);

        document.body.appendChild(badgeElement);

        // Initialize Map Immediately (hidden)
        // The ResizeObserver will handle the layout when it expands.
        if (currentWorkerData) {
            // Small delay to ensure DOM insertion
            setTimeout(() => {
                initMap(currentWorkerData);
            }, 50);
            // Safety: retry after expand-transition time in case first run happened before sizing
            setTimeout(() => {
                if (!mapInitialized) initMap(currentWorkerData);
            }, 250);
        }

        return badgeElement;
    }

    async function fetchFromWorker(address) {
        try {
            const response = await fetch(`${WORKER_URL}/noise/v1?address=${encodeURIComponent(address)}`);
            if (!response.ok) throw new Error(`Worker returned ${response.status}`);
            const data = await response.json();
            const noise = data?.noise;
            const validNoise =
                noise &&
                hasUsableValue(noise.road) &&
                hasUsableValue(noise.rail) &&
                hasUsableValue(noise.total);
            if (!validNoise) {
                throw new Error("Worker returned empty noise values");
            }
            return data;
        } catch (err) {
            logDebug("ImmoNoise: Worker fetch failed, falling back to local.", err);
            return null;
        }
    }

    async function fetchLayerData(address, layerName) {
        try {
            const encodedAddress = encodeURIComponent(address);

            // 1) Geosearch
            const geosearchUrl =
                `https://gdi.berlin.de/searches/bkg/geosearch?` +
                `bbox=369097,5799298,416865,5838236&outputformat=json&srsName=EPSG:25833&count=1&query=${encodedAddress}`;

            const geo = await fetch(geosearchUrl, {
                headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
            }).then(r => r.json());

            const feature = geo.features?.[0];
            if (!feature) throw new Error("No geosearch result.");

            const bboxParam = feature.bbox.join(",");

            // 2) WMS GetFeatureInfo
            const wmsUrl =
                `https://gdi.berlin.de/services/wms/ua_stratlaerm_2022?` +
                `SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&` +
                `FORMAT=image/png&TRANSPARENT=true&` +
                `QUERY_LAYERS=${layerName}&LAYERS=${layerName}&` +
                `SINGLETILE=true&INFO_FORMAT=application/json&FEATURE_COUNT=10&` +
                `I=50&J=50&CRS=EPSG:25833&STYLES=&WIDTH=101&HEIGHT=101&` +
                `BBOX=${encodeURIComponent(bboxParam)}`;

            const wms = await fetch(wmsUrl, {
                headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
            }).then(r => r.json());

            const props = wms.features?.[0]?.properties;
            if (!props) return "bis 55 dB(A)"; // Standard "quiet" level if no feature found

            const dbaValue =
                props["Lärmindex L DEN (Tag/Abend/Nacht) in dB(A)"] ??
                Object.values(props).find(v => typeof v === "string" && v.includes("dB(A)"));

            return translateNoiseLevel(dbaValue || "bis 55 dB(A)");
        } catch (err) {
            logDebug(`ImmoNoise Error [${layerName}]:`, err);
            throw err;
        }
    }

    function init() {
        const run = async () => {
            const host = window.location.hostname;
            const isImmobilienScout = host.includes('immobilienscout24.de');
            const isLivingInBerlin = host.includes('livinginberlin.de');
            const isUrbanGround = host.includes('urbanground.de');
            const isUrbanGroundListing = isUrbanGround && location.pathname.includes('/wohnung-mieten-berlin/');

            // Guard: only run on listing pages we support
            const isScoutListing = isImmobilienScout && location.pathname.includes('/expose/');
            const isLivingListing = isLivingInBerlin && location.pathname.includes('/angebot/');

            if (!isScoutListing && !isLivingListing && !isUrbanGroundListing) {
                clearBadge();
                return;
            }

            let addressText = null;
            let is24Data = null;
            let city = null;

            if (isImmobilienScout) {
                const addressEl = document.querySelector('.address-block');
                if (!addressEl) return;

                addressText = normalizeAddressText(addressEl.innerText.replace(/\n/g, ', '));
                is24Data = getIS24Data();
                city = is24Data?.city || detectCity();
            } else if (isLivingInBerlin) {
                addressText = getLivingInBerlinAddress();
                city = 'Berlin';
            } else if (isUrbanGroundListing) {
                addressText = getUrbanGroundAddress();
                city = 'Berlin';
            }

            if (!addressText) {
                clearBadge();
                return;
            }

            if (addressText === currentAddress) return;

            currentAddress = addressText;

            // Step 1: Detect City & Handle Availability
            const cityName = city || 'this city';

            if (cityName.toLowerCase() !== 'berlin') {
                createBadge([], `We will add ${cityName} soon.`);
                return;
            }

            // Step 2: Check Address Completeness
            let addressToLookup = addressText;

            if (isImmobilienScout && is24Data) {
                if (!is24Data.isFullAddress) {
                    createBadge([], "No address available for this place.");
                    return;
                }
                // Construct high-quality address
                // Format: Street HouseNumber, Zip City
                const constructedAddress = normalizeAddressText(`${is24Data.street || ''} ${is24Data.houseNumber || ''}, ${is24Data.zip || ''} ${is24Data.city || ''}`);
                if (constructedAddress) {
                    addressToLookup = constructedAddress;
                }
            }

            // LivingInBerlin and UrbanGround pages should ensure Berlin is included
            addressToLookup = ensureCityInAddress(addressToLookup, 'Berlin');

            try {
                // Try Worker first
                const workerData = await fetchFromWorker(addressToLookup);

                if (workerData) {
                    currentWorkerData = workerData; // Store for Map
                    const noise = workerData.noise;
                    createBadge([
                        { label: 'Road Traffic', value: noise.road },
                        { label: 'Tram & U-Bahn', value: noise.rail },
                        { label: 'Sum of All Traffic', value: noise.total }
                    ]);
                } else {
                    // Fallback: Fetch all sources in parallel locally
                    const [roadNoise, railNoise, totalNoise] = await Promise.allSettled([
                        fetchLayerData(addressToLookup, LAYER_NAMES.road),
                        fetchLayerData(addressToLookup, LAYER_NAMES.rail),
                        fetchLayerData(addressToLookup, LAYER_NAMES.total)
                    ]);

                    const allFailed = [roadNoise, railNoise, totalNoise].every(r => r.status === 'rejected');
                    if (allFailed) {
                        createBadge([], "Berlin.de noise services are temporarily unavailable. Please try again later.");
                        return;
                    }

                    // Build a lightweight synthetic grid for the map so users still see context when the Worker is unavailable.
                    const fallbackCenter = await geosearchCenterWgs84(addressToLookup);
                    if (fallbackCenter) {
                        currentWorkerData = buildSyntheticGrid(fallbackCenter, {
                            road: roadNoise.status === 'fulfilled' ? roadNoise.value : null,
                            rail: railNoise.status === 'fulfilled' ? railNoise.value : null,
                            total: totalNoise.status === 'fulfilled' ? totalNoise.value : null
                        });
                    }

                    createBadge([
                        {
                            label: 'Road Traffic',
                            value: roadNoise.status === 'fulfilled' ? roadNoise.value : 'Error',
                            error: roadNoise.status === 'rejected' ? roadNoise.reason.message : null
                        },
                        {
                            label: 'Tram & U-Bahn',
                            value: railNoise.status === 'fulfilled' ? railNoise.value : 'Error',
                            error: railNoise.status === 'rejected' ? railNoise.reason.message : null
                        },
                        {
                            label: 'Sum of All Traffic',
                            value: totalNoise.status === 'fulfilled' ? totalNoise.value : 'Error',
                            error: totalNoise.status === 'rejected' ? totalNoise.reason.message : null
                        }
                    ]);
                }
            } catch (err) {
                logDebug("ImmoNoise Global Error:", err);
            }
        };

        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(() => run(), { timeout: 2000 });
        } else {
            setTimeout(run, 1000);
        }
    }

    // Run on load
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

    // Global variables for Map
    let map = null;
    let mapInitialized = false;
    let currentWorkerData = null; // Store data for map usage
    let htmlGridOverlay = null;

    function clearBadge() {
        if (badgeElement) {
            badgeElement.remove();
            badgeElement = null;
        }
        if (map) {
            map.remove();
            map = null;
        }
        mapInitialized = false;
        currentWorkerData = null;
        currentAddress = null;
    }

    function renderHtmlGridOverlay(mapInstance, data) {
        if (!mapInstance || !data) return;
        const container = document.getElementById('immo-noise-map');
        if (!container) return;

        // Remove previous overlay
        if (htmlGridOverlay && htmlGridOverlay.parentNode) {
            htmlGridOverlay.parentNode.removeChild(htmlGridOverlay);
        }

        const cells = data.surroundings?.grid3x3 || data.surroundings?.cells;
        if (!cells || cells.length === 0) return;

        htmlGridOverlay = document.createElement('div');
        htmlGridOverlay.id = 'immo-noise-grid-overlay';
        htmlGridOverlay.style.position = 'absolute';
        htmlGridOverlay.style.top = '0';
        htmlGridOverlay.style.left = '0';
        htmlGridOverlay.style.width = '100%';
        htmlGridOverlay.style.height = '100%';
        htmlGridOverlay.style.pointerEvents = 'none';
        htmlGridOverlay.style.zIndex = '10000';
        htmlGridOverlay.style.mixBlendMode = 'normal';
        container.appendChild(htmlGridOverlay);

        cells.forEach((cell) => {
            const center = cell.center_wgs84;
            if (!center) return;

            const latOffset = (10.1 / 2) / 111132;
            const lonOffset = (10.1 / 2) / (111132 * Math.cos(center.lat * (Math.PI / 180)));

            const sw = L.latLng(center.lat - latOffset, center.lon - lonOffset);
            const ne = L.latLng(center.lat + latOffset, center.lon + lonOffset);

            const p1 = mapInstance.latLngToContainerPoint(sw);
            const p2 = mapInstance.latLngToContainerPoint(ne);

            const left = Math.min(p1.x, p2.x);
            const top = Math.min(p1.y, p2.y);
            const width = Math.abs(p1.x - p2.x);
            const height = Math.abs(p1.y - p2.y);

            const div = document.createElement('div');
            div.className = 'immo-noise-grid-cell';
            div.style.position = 'absolute';
            div.style.left = `${left}px`;
            div.style.top = `${top}px`;
            div.style.width = `${width}px`;
            div.style.height = `${height}px`;
            div.style.background = getColor(cell.noise.total);
            div.style.opacity = '0.72';
            div.style.border = '1px solid #ffffff';
            div.style.boxSizing = 'border-box';
            div.style.pointerEvents = 'none';
            htmlGridOverlay.appendChild(div);
        });
    }

    function initMap(data) {
        if (mapInitialized || !data || !data.center_wgs84) return;

        const container = document.getElementById('immo-noise-map');
        if (!container) return;
        container.style.position = 'relative';
        container.style.overflow = 'hidden';

        // Add scoped CSS to protect our overlay from host page styles
        if (!container.querySelector('style[data-immo-noise-style]')) {
            const styleEl = document.createElement('style');
            styleEl.dataset.immoNoiseStyle = '1';
            styleEl.textContent = `
                #immo-noise-map .leaflet-immo-noise-pane path,
                #immo-noise-map .leaflet-immo-noise-pane rect {
                    vector-effect: non-scaling-stroke;
                }
            `;
            container.appendChild(styleEl);
        }

        // Use SVG renderer (more robust against site-level canvas CSS) and set our own overlay pane
        map = L.map('immo-noise-map', {
            zoomControl: false,
            attributionControl: false,
            zoomSnap: 0.1,
            preferCanvas: false
        });

        // Dedicated pane for noise overlay to keep it above tiles and site styles
        const noisePane = map.createPane('immo-noise-pane');
        noisePane.style.zIndex = '650';
        noisePane.style.pointerEvents = 'none';

        // ResizeObserver to handle CSS transitions automatically
        const resizeObserver = new ResizeObserver(() => {
            if (map) {
                map.invalidateSize();
                // Keep centered
                if (data && data.center_wgs84) {
                    let cLat = data.center_wgs84.lat;
                    let cLon = data.center_wgs84.lon;
                    // Try to extract cell 4 center for better precision
                    const c = data.surroundings?.grid3x3 || data.surroundings?.cells;
                    if (c && c[4]) {
                        cLat = c[4].center_wgs84.lat;
                        cLon = c[4].center_wgs84.lon;
                    }
                    map.setView([cLat, cLon], map.getZoom(), { animate: false });
                }
                // Re-render HTML overlay to stay aligned after size changes
                renderHtmlGridOverlay(map, data);
            }
        });
        resizeObserver.observe(container);

        // Keep HTML overlay aligned on move/zoom
        const reprojectOverlay = () => renderHtmlGridOverlay(map, data);
        map.on('move', reprojectOverlay);
        map.on('zoom', reprojectOverlay);

        // Add tiles first
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 22
        }).addTo(map);

        const cells = data.surroundings?.grid3x3 || data.surroundings?.cells;

        // Center the map on the MIDDLE cell (Index 4 in 3x3 grid: NW, N, NE, W, C, E, SW, S, SE)
        // This ensures the "main box" is perfectly centered.
        let centerLat = data.center_wgs84.lat;
        let centerLon = data.center_wgs84.lon;

        if (cells && cells[4] && cells[4].center_wgs84) {
            centerLat = cells[4].center_wgs84.lat;
            centerLon = cells[4].center_wgs84.lon;
        }

        map.setView([centerLat, centerLon], 18);

        // Render target marker
        L.circleMarker([data.center_wgs84.lat, data.center_wgs84.lon], {
            radius: 5, fillColor: "#0076ff", color: "#fff", weight: 2, opacity: 1, fillOpacity: 1, pane: 'immo-noise-pane'
        }).addTo(map);
        forceNoiseStyles();

        // Draw grid using HTML overlay (works on all hosts and prevents double grids)
        renderHtmlGridOverlay(map, data);

        mapInitialized = true;
    }

    // Some hosts override SVG/Path styles globally; enforce ours with !important
    function forceNoiseStyles() {
        const pane = document.querySelector('.leaflet-immo-noise-pane');
        if (!pane) return;
        pane.querySelectorAll('path, rect').forEach(el => {
            if (el.dataset.immoNoiseStyled) return;
            const fill = el.getAttribute('fill') || el.style.fill || '#e74c3c';
            const stroke = el.getAttribute('stroke') || el.style.stroke || '#ffffff';
            const fillOpacity = el.getAttribute('fill-opacity') || el.style.fillOpacity || '0.72';
            const strokeOpacity = el.getAttribute('stroke-opacity') || el.style.strokeOpacity || '1';
            const strokeWidth = el.getAttribute('stroke-width') || el.style.strokeWidth || '1.2';
            el.style.setProperty('fill', fill, 'important');
            el.style.setProperty('fill-opacity', fillOpacity, 'important');
            el.style.setProperty('stroke', stroke, 'important');
            el.style.setProperty('stroke-opacity', strokeOpacity, 'important');
            el.style.setProperty('stroke-width', strokeWidth, 'important');
            el.dataset.immoNoiseStyled = '1';
        });
    }

    function getColor(noiseValue) {
        if (!noiseValue) return '#ccc';
        const numbers = noiseValue.match(/\d+/g);
        if (!numbers || numbers.length === 0) {
            if (noiseValue.includes("< 55")) return '#1b5e20';
            return '#ccc';
        }
        const maxVal = Math.max(...numbers.map(Number));

        if (maxVal <= 55) return '#1b5e20';
        if (maxVal <= 59) return '#2ecc71';
        if (maxVal <= 64) return '#f1c40f';
        if (maxVal <= 69) return '#e74c3c';
        return '#650c51';
    }

    // SPA support: watch DOM mutations and URL changes (Angular/React routers)
    const observer = new MutationObserver(debounce(() => {
        init();
    }, 600));
    observer.observe(document.body, { childList: true, subtree: true });

    let lastUrl = location.href;
    const checkUrlChange = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            clearBadge();
            init();
        }
    };
    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('pushstate', checkUrlChange); // in case sites dispatch custom events
    setInterval(checkUrlChange, 800);

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Translates German noise level descriptions to symbols.
     * Shared logic with the worker to ensure fallback data is also in English/Symbols.
     */
    function translateNoiseLevel(text) {
        if (!text) return text;
        return text.replace(/\bbis\b/g, "<").replace(/\bab\b/g, ">").replace(/bis zu/g, "<=");
    }

    function getNoiseContext(dB) {
        if (dB <= 55) return { label: 'Quiet', tooltip: 'Like a library or bird calls 🌿' };
        if (dB <= 59) return { label: 'Moderate', tooltip: 'Like a refrigerator or quiet conversation 🗣️' };
        if (dB <= 64) return { label: 'Noisy', tooltip: 'Like a TV or open-plan office 📺' };
        if (dB <= 69) return { label: 'Loud', tooltip: 'Like city traffic or a vacuum cleaner 🚗' };
        return { label: 'Very Loud', tooltip: 'Like a hair dryer or busy street 📢' };
    }
})();
