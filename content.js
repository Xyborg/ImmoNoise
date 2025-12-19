/**
 * ImmoNoise Content Script
 */

(async () => {
    let currentAddress = null;
    let badgeElement = null;

    // Final custom domain for your Worker
    const WORKER_URL = 'https://api-immonoise.martinaberastegue.com';

    function detectCity() {
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
            console.error("ImmoNoise: Error detecting city", e);
        }
        return null;
    }

    function createBadge(results, cityMessage = null) {
        if (badgeElement) {
            badgeElement.remove();
        }

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

                const labelEl = document.createElement('div');
                labelEl.className = 'immo-noise-label';
                labelEl.innerText = res.label;

                const valueEl = document.createElement('div');
                valueEl.className = 'immo-noise-value';

                if (res.error) {
                    valueEl.innerText = 'N/A';
                    valueEl.style.color = '#ccc';
                    entryEl.title = res.error;
                } else {
                    valueEl.innerText = res.value;

                    // Robust color coding logic using numeric extraction
                    const numbers = res.value.match(/\d+/g);
                    if (numbers && numbers.length > 0) {
                        const maxVal = Math.max(...numbers.map(Number));

                        if (maxVal <= 55) {
                            valueEl.classList.add('immo-noise-level-none');
                        } else if (maxVal <= 59) {
                            valueEl.classList.add('immo-noise-level-low');
                        } else if (maxVal <= 64) {
                            valueEl.classList.add('immo-noise-level-mid');
                        } else if (maxVal <= 69) {
                            valueEl.classList.add('immo-noise-level-high');
                        } else {
                            valueEl.classList.add('immo-noise-level-extreme');
                        }
                    }
                }

                entryEl.appendChild(labelEl);
                entryEl.appendChild(valueEl);
                bodyEl.appendChild(entryEl);
            });
        }

        badgeElement.appendChild(bodyEl);
        document.body.appendChild(badgeElement);
        return badgeElement;
    }

    async function fetchFromWorker(address) {
        try {
            const response = await fetch(`${WORKER_URL}/noise?address=${encodeURIComponent(address)}`);
            if (!response.ok) throw new Error(`Worker returned ${response.status}`);
            return await response.json();
        } catch (err) {
            console.warn("ImmoNoise: Worker fetch failed, falling back to local.", err);
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

            return dbaValue || "bis 55 dB(A)";
        } catch (err) {
            console.error(`ImmoNoise Error [${layerName}]:`, err);
            throw err;
        }
    }

    function init() {
        const run = async () => {
            const addressEl = document.querySelector('.address-block');
            if (!addressEl) return;

            const addressText = addressEl.innerText.replace(/\n/g, ', ').trim();
            if (addressText === currentAddress) return;

            currentAddress = addressText;

            // Step 1: Detect City
            const city = detectCity();
            if (city && city.toLowerCase() !== 'berlin') {
                createBadge([], `We will add ${city} soon.`);
                return;
            }

            try {
                // Try Worker first
                const workerData = await fetchFromWorker(addressText);

                if (workerData) {
                    createBadge([
                        { label: 'Road Traffic', value: workerData.road },
                        { label: 'Tram & U-Bahn', value: workerData.rail },
                        { label: 'Sum of All Traffic', value: workerData.total }
                    ]);
                } else {
                    // Fallback: Fetch all sources in parallel locally
                    const [roadNoise, railNoise, totalNoise] = await Promise.allSettled([
                        fetchLayerData(addressText, 'bb_strasse_gesamt_den2022'),
                        fetchLayerData(addressText, 'bc_tram_ubahn_den2022'),
                        fetchLayerData(addressText, 'bf_gesamtlaerm_den2022')
                    ]);

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
                console.error("ImmoNoise Global Error:", err);
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

    // Since ImmoScout is a SPA, we need to watch for changes
    const observer = new MutationObserver(debounce(() => {
        init();
    }, 2000));

    observer.observe(document.body, { childList: true, subtree: true });

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
})();
