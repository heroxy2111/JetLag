// Wartet, bis das gesamte HTML-Dokument geladen und verarbeitet ist.
document.addEventListener('DOMContentLoaded', () => {

    // =================================================================================
    // 1. VARIABLEN UND DOM-REFERENZEN
    // =================================================================================

    // Speichert Referenzen auf alle HTML-Elemente, die wir per JavaScript steuern wollen.
    const areaInput = document.getElementById('area-input');
    const addAreaBtn = document.getElementById('add-area-btn');
    const autocompleteResults = document.getElementById('autocomplete-results');
    const areaList = document.getElementById('area-list');
    const generateMapBtn = document.getElementById('generate-map-btn');
    const loader = document.getElementById('loader');
    const resultsPanel = document.getElementById('results-panel');
    const lineLegend = document.getElementById('line-legend');
    const gameSizeIndicator = document.getElementById('game-size-indicator');
    const toggleHidingZones = document.getElementById('toggle-hiding-zones');
    const poiToggles = document.querySelectorAll('.poi-toggle');
    const exportMapBtn = document.getElementById('export-map-btn');

    // =================================================================================
    // 2. KARTEN-INITIALISIERUNG
    // =================================================================================

    // Erstellt die Leaflet-Karte und fügt sie in das <div id="map"> ein.
    const map = L.map('map').setView([49.76839565456551, 4.725107381427725], 6); // Startansicht zentriert auf Deutschland

    // Erstellt "Ebenen" (panes) in der Karte, um die Zeichenreihenfolge zu steuern.
    // Linien werden auf einer unteren Ebene gezeichnet, Haltestellen darüber.
    map.createPane('linesPane');
    map.createPane('stationsPane');
    map.getPane('linesPane').style.zIndex = 400;
    map.getPane('stationsPane').style.zIndex = 401; // Höherer z-index = weiter vorne

    // Fügt eine helle, minimalistische Basiskarte von CartoDB hinzu.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
    
    // Fügt eine Maßstabsleiste hinzu (nur metrisch).
    L.control.scale({ imperial: false }).addTo(map);

    // =================================================================================
    // 3. GLOBALE STATUS-VARIABLEN
    // =================================================================================

    let areaData = []; // Speichert die GeoJSON-Daten für jedes hinzugefügte Gebiet.
    let combinedGameAreaForDisplay = null; // Speichert die vereinigte Form aller Gebiete (nur zur Anzeige).
    let debounceTimer; // Timer für die Autocomplete-Funktion, um API-Aufrufe zu verzögern.
    
    // Objekt, das alle Kartenebenen (Layer) bündelt, die wir hinzufügen und entfernen.
    const layers = {
        areas: L.featureGroup().addTo(map),
        lines: L.featureGroup().addTo(map),
        stations: L.featureGroup().addTo(map),
        hidingZones: L.featureGroup(),
        pois: {},
        lineLabels: L.featureGroup().addTo(map),
        mask: L.layerGroup().addTo(map)
    };

    let processedLines = []; // Speichert die verarbeiteten Linien-Objekte.
    let stationMarkers = new Map(); // Speichert die einzelnen Marker für jede Haltestelle.
    let allStationsInArea = new Map(); // Cache für alle gefundenen Haltestellen im Gebiet.
    let recommendedGameSize = 'Small';

    // =================================================================================
    // 4. EVENT LISTENERS (Benutzer-Interaktionen)
    // =================================================================================

    // Reagiert auf Eingaben im Suchfeld für Orte.
    areaInput.addEventListener('input', () => {
        clearTimeout(debounceTimer); // Stoppt den vorherigen Timer.
        const query = areaInput.value.trim();
        if (query.length < 3) { // Startet die Suche erst ab 3 Zeichen.
            autocompleteResults.innerHTML = '';
            autocompleteResults.classList.add('hidden');
            return;
        }
        // Startet einen neuen Timer. Die API wird erst nach 300ms ohne weitere Eingabe aufgerufen.
        debounceTimer = setTimeout(() => {
            fetchAutocomplete(query);
        }, 100);
    });

    // Fügt ein Gebiet hinzu, wenn der "Add"-Button geklickt wird.
    addAreaBtn.addEventListener('click', () => handleAddArea(areaInput.value));

    // Versteckt die Autocomplete-Vorschläge, wenn man irgendwo anders hinklickt.
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.input-group-wrapper')) {
            autocompleteResults.classList.add('hidden');
        }
    });

    // Entfernt ein Gebiet aus der Liste.
    areaList.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-area')) {
            const areaId = e.target.parentElement.dataset.id;
            removeArea(areaId);
        }
    });
    
    // Startet die Kartengenerierung.
    generateMapBtn.addEventListener('click', generateMap);
    
    // Schaltet die "Hiding Zones" (Kreise um Haltestellen) an oder aus.
    toggleHidingZones.addEventListener('click', () => {
        if (toggleHidingZones.checked) map.addLayer(layers.hidingZones);
        else map.removeLayer(layers.hidingZones);
    });

    // Schaltet die POI-Layer (Points of Interest) an oder aus.
    poiToggles.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const poiType = checkbox.value;
            if (checkbox.checked) {
                if (!layers.pois[poiType] || layers.pois[poiType].getLayers().length === 0) {
                    fetchAndDrawPOIs(poiType);
                } else {
                    map.addLayer(layers.pois[poiType]);
                }
            } else {
                if (layers.pois[poiType]) map.removeLayer(layers.pois[poiType]);
            }
        });
    });
    
    // Exportiert die aktuelle Kartenansicht als PNG-Bild.
    exportMapBtn.addEventListener('click', () => {
        loader.classList.remove('hidden');
        leafletImage(map, (err, canvas) => {
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = 'hide-and-seek-map.png';
            a.click();
            loader.classList.add('hidden');
        });
    });

    // =================================================================================
    // 5. KERNFUNKTIONEN
    // =================================================================================

    function hexToRgb(hex) {
    const c = hex.replace('#','');
    const v = c.length === 3 ? c.split('').map(ch => ch+ch).join('') : c;
    const n = parseInt(v, 16);
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
    }
    function readableTextColor(bgHex) {
    try {
        const {r,g,b} = hexToRgb(bgHex);
        // einfache Luminanzschätzung – hell -> schwarz, dunkel -> weiß
        const L = (0.2126*r + 0.7152*g + 0.0722*b) / 255;
        return L > 0.6 ? '#000' : '#fff';
    } catch { return '#000'; }
    }

    /**
     * Holt Autocomplete-Vorschläge von der Nominatim API und zeigt sie an.
     * @param {string} query - Die Suchanfrage des Benutzers.
     */
    // Diese Funktion bleibt fast gleich, sie nutzt Photon für die Vorschläge.
    async function fetchAutocomplete(query) {
        if (query.length < 3) {
            autocompleteResults.innerHTML = '';
            autocompleteResults.classList.add('hidden');
            return;
        }
        try {
            const response = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`);
            const data = await response.json();
            const results = data.features;

            autocompleteResults.innerHTML = '';
            autocompleteResults.classList.remove('hidden');

            results.forEach(result => {
                const props = result.properties;
                const displayName = [props.name, props.city, props.state, props.country]
                                    .filter(Boolean).join(', ');

                const div = document.createElement('div');
                div.textContent = displayName;
                div.addEventListener('click', () => {
                    areaInput.value = displayName;
                    autocompleteResults.innerHTML = '';
                    autocompleteResults.classList.add('hidden');

                    // NEU: Wir rufen jetzt eine neue Funktion auf,
                    // die sich die Geometrie von Nominatim holt.
                    // Wir übergeben den sauberen Namen, den Photon uns gegeben hat.
                    handleAddArea(displayName);
                });
                autocompleteResults.appendChild(div);
            });
        } catch (e) {
            console.error("Autocomplete fetch failed:", e);
        }
    }

    /**
     * Holt die Geometrie für ein ausgewähltes Gebiet und fügt es zur Liste hinzu.
     * @param {string} query - Der Name des Gebiets.
     */
    async function handleAddArea(query) {
        if (!query) return;
        loader.classList.remove('hidden');
        areaInput.disabled = true;
        addAreaBtn.disabled = true;

        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&polygon_geojson=1&limit=1`);
            const data = await response.json();

            if (data && data.length > 0 && data[0].geojson) {
                const area = data[0];
                const id = `area-${Date.now()}`;
                areaData.push({ id, name: area.display_name, geojson: area.geojson });
                renderAreaList();
                updateGameArea();
                areaInput.value = '';
            } else {
                alert('Area not found or has no boundary. Please select a suggestion from the list.');
            }
        } catch (error) {
            console.error('Error fetching area:', error);
            alert('Failed to fetch area data.');
        } finally {
            loader.classList.add('hidden');
            areaInput.disabled = false;
            addAreaBtn.disabled = false;
        }
    }

    /**
     * Entfernt ein Gebiet aus der `areaData`-Liste und aktualisiert die Anzeige.
     * @param {string} id - Die ID des zu entfernenden Gebiets.
     */
    function removeArea(id) {
        areaData = areaData.filter(area => area.id !== id);
        renderAreaList();
        updateGameArea();
    }
    
    /**
     * Zeichnet die Liste der hinzugefügten Gebiete in der UI.
     */
    function renderAreaList() {
        areaList.innerHTML = '';
        areaData.forEach(area => {
            const li = document.createElement('li');
            li.dataset.id = area.id;
            const displayName = area.name.length > 30 ? area.name.substring(0, 27) + '...' : area.name;
            li.innerHTML = `${displayName} <button class="remove-area">&times;</button>`;
            areaList.appendChild(li);
        });
        generateMapBtn.disabled = areaData.length === 0;
    }

    /**
     * Erzeugt ein "invertiertes" Polygon (Maske), das alles außerhalb des übergebenen GeoJSON-Features abdeckt.
     * @param {object} geoJSON - Das GeoJSON-Objekt (kann Feature oder Geometry sein) des Spielgebiets.
     * @returns {object|null} Ein GeoJSON-Polygon mit dem Spielgebiet als "Loch" oder null bei einem Fehler.
     */
    function createInvertedMask(geoJSON) {
        // --- KORREKTUR START ---
        // Zuerst prüfen, ob wir überhaupt ein valides Objekt haben.
        if (!geoJSON || !geoJSON.type) {
            console.error("Invalid GeoJSON object passed to createInvertedMask", geoJSON);
            return null;
        }
        
        // Wir normalisieren den Input: Egal ob wir ein Feature oder eine Geometry bekommen,
        // 'geometry' enthält am Ende immer das reine Geometrie-Objekt.
        const geometry = geoJSON.type === 'Feature' ? geoJSON.geometry : geoJSON;

        if (!geometry || !geometry.type) {
            console.error("Could not extract a valid geometry from the GeoJSON object", geoJSON);
            return null;
        }
        // --- KORREKTUR ENDE ---


        // 1. Definiere ein Polygon, das die ganze Welt abdeckt (Außengrenze)
        const worldCoords = [
            [
                [-180, -90],
                [-180, 90],
                [180, 90],
                [180, -90],
                [-180, -90]
            ]
        ];

        // 2. Extrahiere die Koordinaten des Spielgebiets, die zu "Löchern" werden
        const gameAreaHoles = [];
        
        // Wir verwenden jetzt die sichere 'geometry'-Variable
        if (geometry.type === 'Polygon') {
            geometry.coordinates.forEach(ring => gameAreaHoles.push(ring));
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(polygonCoords => {
                polygonCoords.forEach(ring => gameAreaHoles.push(ring));
            });
        }

        // 3. Erstelle das finale GeoJSON für die Maske
        return {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [worldCoords[0], ...gameAreaHoles]
            }
        };
    }


    /**
     * Vereinigt alle Gebiete zu einer einzigen Form und zeichnet eine invertierte Maske auf der Karte.
     */
    function updateGameArea() {
        // Bestehende Layer entfernen
        layers.areas.clearLayers();
        // Annahme: Du hast einen neuen Layer für die Maske
        if (layers.mask) {
        layers.mask.clearLayers();
        }


        if (areaData.length === 0) {
            combinedGameAreaForDisplay = null;
            return;
        }

        // --- LÖSUNG FÜR PROBLEM 1: Robuste Vereinigung ---
        let combinedArea = turf.clone(areaData[0].geojson); // Mit einer Kopie starten
        if (areaData.length > 1) {
            for (let i = 1; i < areaData.length; i++) {
                try {
                    // Versuche, das nächste Gebiet iterativ zu vereinigen
                    combinedArea = turf.union(combinedArea, areaData[i].geojson);
                } catch (e) {
                    console.warn(`Could not unite area ${areaData[i].name}. Skipping it for now.`, e);
                    // Wenn die Vereinigung fehlschlägt, überspringen wir dieses Gebiet einfach
                    // und machen mit dem nächsten weiter. Das verhindert den Totalabsturz.
                }
            }
        }

        // Speichere das Ergebnis für die Spiellogik. Dies ist die tatsächliche GameZone.
        combinedGameAreaForDisplay = combinedArea;


        // --- LÖSUNG FÜR PROBLEM 2: Invertierte Maske ---
        if (combinedGameAreaForDisplay) {
            // Erstelle das invertierte Polygon für die Anzeige
            const invertedMask = createInvertedMask(combinedGameAreaForDisplay);

            // Zeichne die Maske auf der Karte
            const maskLayer = L.geoJSON(invertedMask, {
                style: {
                    color: '#333',      // Farbe des Rands (optional)
                    weight: 0,          // Keine sichtbare Grenze
                    fillColor: '#333',  // Grauton
                    fillOpacity: 0.5    // Halbtransparent
                }
            });

            // Füge die Maske zum neuen Layer hinzu
            if (layers.mask) {
            layers.mask.addLayer(maskLayer);
            } else {
            // Fallback, falls der Layer nicht existiert: direkt zur Karte hinzufügen
            maskLayer.addTo(map);
            }

            // Optional: Du kannst weiterhin den Rand des eigentlichen Gebiets zeichnen, wenn du möchtest
            const areaBoundaryLayer = L.geoJSON(combinedGameAreaForDisplay, {
                style: {
                    color: '#e74c3c', // Rote Grenze
                    weight: 2,
                    fill: false // Keine Füllung!
                }
            });
            layers.areas.addLayer(areaBoundaryLayer);

            // Passe die Kartenansicht an das Spielgebiet an
            map.fitBounds(L.geoJSON(combinedGameAreaForDisplay).getBounds());
        }
    }

    /**
     * Hauptfunktion: Startet den gesamten Prozess der Kartenerstellung.
     */
    async function generateMap() {
        if (areaData.length === 0) {
            alert("Please add at least one game area.");
            return;
        }

        loader.classList.remove('hidden');
        generateMapBtn.disabled = true;
        clearMapData();

        try {
            const overpassQuery = buildOverpassQuery();
            console.log(overpassQuery);
            const osmData = await fetchOverpassData(overpassQuery);
            processedLines = processOverpassData(osmData);

            if (processedLines.length === 0) {
                 alert("No transit lines could be found for the selected area and types.");
            }
            
            drawLines();
            drawStations();
            updateGameSizeIndicator();
            drawHidingZones();
            populateLineLegend();
            resultsPanel.classList.remove('hidden');
        } catch (error) {
            console.error("Map Generation Failed:", error);
            alert("An error occurred during map generation.");
        } finally {
            loader.classList.add('hidden');
            generateMapBtn.disabled = false;
        }
    }

    /**
     * Setzt alle Kartenebenen und Daten zurück.
     */
    function clearMapData() {
        layers.lines.clearLayers();
        layers.stations.clearLayers();
        layers.hidingZones.clearLayers();
        layers.lineLabels.clearLayers();
        Object.values(layers.pois).forEach(layer => layer.clearLayers());
        layers.pois = {};
        lineLegend.innerHTML = '';
        processedLines = [];
        stationMarkers.clear();
        allStationsInArea.clear();
        poiToggles.forEach(cb => cb.checked = false);
        toggleHidingZones.checked = false;
    }
    
    /**
     * Konvertiert ein GeoJSON-Polygon in das für die Overpass API benötigte Format.
     * @param {object} geojson - Das GeoJSON-Objekt.
     * @returns {string} Ein String mit Koordinatenpaaren.
     */
    function geojsonToOverpassPoly(geojson) {
        const geometry = geojson.type === 'Feature' ? geojson.geometry : geojson;
        if (!geometry || !geometry.type) { return ''; }
        let coords;
        if (geometry.type === 'Polygon') {
            coords = geometry.coordinates[0];
        } else if (geometry.type === 'MultiPolygon') {
            let largestPolygon = geometry.coordinates.reduce((a, b) => turf.area(turf.polygon(a)) > turf.area(turf.polygon(b)) ? a : b);
            coords = largestPolygon[0];
        } else { return ''; }
        return coords.map(p => `${p[1]} ${p[0]}`).join(' ');
    }

    /**
     * Baut die Abfrage für die Overpass API basierend auf den Benutzereingaben zusammen.
     * @returns {string} Die fertige Overpass QL-Abfrage.
     */
    function buildOverpassQuery() {
        const bounds = layers.areas.getBounds();
        const bbox = `(${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()})`;

        const selectedFilters = Array.from(document.querySelectorAll('#transit-types input:checked'))
                                   .map(input => input.dataset.osmFilter);
            
        if (selectedFilters.length === 0) throw new Error("No transit types selected");
        
        // Fügt die Bounding-Box zu jedem Filter hinzu und verbindet sie mit Semikolons.
        const finalFilter = selectedFilters.map(f => `${f}${bbox}`).join(';');

        return `
            [out:json][timeout:300];
            (
              ${finalFilter};
            );
            (._;>;);
            out geom;
        `;
    }
    
    /**
     * Sendet die Abfrage an die Overpass API.
     * @param {string} query - Die Overpass-Abfrage.
     * @returns {Promise<object>} Die JSON-Antwort von der API.
     */
    async function fetchOverpassData(query) {
        const url = 'https://overpass-api.de/api/interpreter';
        const response = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
        if (!response.ok) throw new Error(`Overpass API error: ${response.statusText}`);
        return response.json();
    }
    
    /**
     * Verarbeitet die Rohdaten von der Overpass API zu sauberen Linien- und Haltestellenobjekten.
     * @param {object} osmData - Die API-Antwort.
     * @returns {{lines: Array, stations: Array}} Ein Objekt mit den verarbeiteten Linien und Haltestellen.
     */
    function processOverpassData(osmData) {
        const elements = osmData.elements;
        const nodes = new Map(elements.filter(e => e.type === 'node').map(n => [n.id, n]));
        const ways = new Map(elements.filter(e => e.type === 'way').map(w => [w.id, w]));
        const lines = new Map();
        
        elements.filter(e => e.type === 'relation' && e.tags.type === 'route').forEach(route => {
            const ref = route.tags.ref || route.tags.name || `Route ${route.id}`;
            if (!lines.has(ref)) {
                lines.set(ref, { 
                    name: ref, 
                    color: route.tags.colour || getRandomColor(), 
                    ways: [],
                    stationIds: new Set()
                });
            }
            const line = lines.get(ref);
            route.members.forEach(member => {
                if (member.type === 'way' && ways.has(member.ref)) {
                    line.ways.push(ways.get(member.ref));
                }
            });
        });
        
        nodes.forEach(node => {
            if (node.tags && (node.tags.public_transport === 'station' || node.tags.public_transport === 'stop_position' || node.tags.railway === 'station')) {
                for(const area of areaData) {
                    if (turf.booleanPointInPolygon(turf.point([node.lon, node.lat]), area.geojson)) {
                        if (!allStationsInArea.has(node.id)) {
                            allStationsInArea.set(node.id, { id: node.id, name: node.tags.name || 'Unnamed Station', lat: node.lat, lon: node.lon });
                        }
                        break;
                    }
                }
            }
        });
        
        return Array.from(lines.values()).map(line => {
            const allCoords = line.ways.flatMap(way => way.nodes.map(nodeId => nodes.get(nodeId)).filter(Boolean));
            if (allCoords.length < 2) return null;

            line.allCoords = allCoords;

            const finalSegments = [];
            
            line.ways.forEach(way => {
                const wayCoords = way.nodes.map(nodeId => nodes.get(nodeId))
                                           .filter(Boolean)
                                           .map(node => [node.lon, node.lat]);

                if(wayCoords.length < 2) return;

                let currentSegment = [];
                for (let i = 0; i < wayCoords.length; i++) {
                    const point = turf.point(wayCoords[i]);
                    let isInside = areaData.some(area => turf.booleanPointInPolygon(point, area.geojson));

                    if (isInside) {
                        currentSegment.push(wayCoords[i]);
                    } else {
                        if (currentSegment.length > 1) finalSegments.push(turf.lineString(currentSegment));
                        currentSegment = [];
                    }
                }
                if (currentSegment.length > 1) finalSegments.push(turf.lineString(currentSegment));
            });

            if (finalSegments.length > 0) {
                allCoords.forEach(node => {
                    if (allStationsInArea.has(node.id)) {
                        line.stationIds.add(node.id);
                    }
                });
                return { ...line, geojson: turf.featureCollection(finalSegments) };
            }

            return null;
        }).filter(Boolean);
    }

    /**
     * Aktualisiert die Anzeige für die empfohlene Spielgröße.
     */
    function updateGameSizeIndicator() {
        if (!combinedGameAreaForDisplay) return;
        const stationCount = stationMarkers.size;
        
        if (stationCount > 500 || turf.area(combinedGameAreaForDisplay) / 1000000 > 2500) recommendedGameSize = 'Large';
        else if (stationCount > 100 || turf.area(combinedGameAreaForDisplay) / 1000000 > 250) recommendedGameSize = 'Medium';
        else recommendedGameSize = 'Small';

        gameSizeIndicator.textContent = `${stationCount} stations, ${Math.round(turf.area(combinedGameAreaForDisplay) / 1000000)} km²`;
    }
    
    /**
     * Zeichnet die Linien auf der Karte, inklusive des Versatzes für parallele Linien.
     */
    function drawLines() {
        const wayUsage = new Map();
        processedLines.forEach(line => {
            line.ways.forEach(way => {
                if (!wayUsage.has(way.id)) wayUsage.set(way.id, []);
                wayUsage.get(way.id).push(line.name);
            });
        });

        processedLines.forEach((line) => {
            const lineWays = new Set(line.ways.map(w => w.id));
            const overlappingLines = new Set([line.name]);
            lineWays.forEach(wayId => {
                wayUsage.get(wayId).forEach(lineName => overlappingLines.add(lineName));
            });

            const group = Array.from(overlappingLines).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
            const groupIndex = group.indexOf(line.name);
            const groupSize = group.length;
            
        //    const offset = (groupIndex - (groupSize - 1) / 2) * 0.00004;
            const offset = 0;

            const lineLayer = L.geoJSON(line.geojson, {
                pane: 'linesPane',
                style: { color: line.color, weight: 3.5, opacity: 0.9 },
                coordsToLatLng: (coords) => new L.LatLng(coords[1] - offset, coords[0] - offset)
            });
            line.layer = lineLayer;
            layers.lines.addLayer(lineLayer);
            drawLabelsForLine(line, offset, line.color);
        });
    }
    
    /**
     * Zeichnet die Haltestellenpunkte auf der Karte.
     */
    function drawStations() {
        stationMarkers.clear();
        layers.stations.clearLayers();
        const stationNamesDrawn = new Set();
        
        processedLines.forEach(line => {
            line.stationIds.forEach(id => {
                const stationData = allStationsInArea.get(id);
                if (!stationData || (stationData.name && stationNamesDrawn.has(stationData.name))) return;
                
                if(stationData.name) stationNamesDrawn.add(stationData.name);

                const marker = L.circleMarker([stationData.lat, stationData.lon], {
                    pane: 'stationsPane',
                    radius: 3.5,
                    color: '#333',
                    weight: 1.5,
                    fillColor: 'white',
                    fillOpacity: 1
                });
                marker.visibleCount = 0;
                stationMarkers.set(id, marker);
            });
        });
    }

    /**
     * Fügt ein einzelnes Label zur Karte hinzu.
     * @param {string} text - Der Text des Labels.
     * @param {Array} latlng - Die Koordinaten [lat, lng].
     * @param {number} offset - Der vertikale Versatz.
     */
    function addLabel(text, latlng, opts = {}) {
        const { offset = 0, color = '#ff6600' } = opts;
        const textColor = readableTextColor(color);

        const icon = L.divIcon({
            // Wichtig: keine feste iconSize -> passt sich dem Inhalt an
            className: '',
            html: `<div class="line-label" style="--line-color:${color};--text-color:${textColor}">${text}</div>`,
            iconSize: null,
            // Anker kann je nach Geschmack angepasst werden; so sitzt es leicht links oberhalb
            iconAnchor: [-10, 8]
        });

        L.marker([latlng[0] - offset, latlng[1]], { icon, pane: 'stationsPane' })
            .addTo(layers.lineLabels);
    }

    /**
     * Zeichnet Labels für eine Linie an den Start-/Endpunkten und Übergangspunkten.
     *
     * @param {object} line Die verarbeiteten Liniendaten.
     * @param {number} offset Der Versatz, um parallele Linien zu unterscheiden.
     * @param {string} color Die Farbe der Linie.
     */
    function drawLabelsForLine(line, offset, color) {
        if (!line.geojson || !line.geojson.features || line.geojson.features.length === 0) return;

        // Sortiere die Haltestellen in die richtige Reihenfolge
        const stationSequence = line.allCoords.filter(point => line.stationIds.has(point.id));

        // Iteriere über die sortierte Haltestellen-Sequenz
        for (let i = 0; i < stationSequence.length; i++) {
            const curStation = stationSequence[i];
            const nextStation = stationSequence[i+1];

            // Prüfen, ob die Station bereits besucht wurde (Hin- und Rückfahrt)
            if (curStation.tags.name == nextStation.tags.name) {
                addLabel(line.name, [curStation.lat, curStation.lon], { offset, color });
                break;
            }

            else if (i == 0)
            {
                addLabel(line.name, [curStation.lat, curStation.lon], { offset, color });
            }
        }
    }
        
    /**
     * Zeichnet die "Hiding Zones" um die Haltestellen.
     */
    function drawHidingZones() {
        layers.hidingZones.clearLayers();
        const radius = (recommendedGameSize === 'Large') ? 1000 : 500;
        stationMarkers.forEach(marker => {
            L.circle(marker.getLatLng(), { radius, color: '#3498db', weight: 1, fillOpacity: 0.1 }).addTo(layers.hidingZones);
        });
    }

    /**
     * Holt und zeichnet POIs (Points of Interest) als Emoji-Pins.
     * Unterstützte Werte (aus den Checkboxen):
     *  amusement_park, aquarium, cinema, ebassy, golf, hospital, airport,
     *  library, museum, park, zoo
     */
    async function fetchAndDrawPOIs(poiType) {
        if (!combinedGameAreaForDisplay) return;

        // Tippfehler abfangen
        const normalizedType = poiType === 'ebassy' ? 'embassy' : poiType;

        if (!layers.pois[normalizedType]) layers.pois[normalizedType] = L.featureGroup();
        else layers.pois[normalizedType].clearLayers();

        loader.classList.remove('hidden');

        const polyString = geojsonToOverpassPoly(combinedGameAreaForDisplay);

        const poiSpecs = {
            amusement_park: {
            filters: [`["tourism"="theme_park"]`],
            emoji: '🎢',
            label: 'Amusement Park'
            },
            aquarium: {
            filters: [`["tourism"="aquarium"]`],
            emoji: '🐠',
            label: 'Aquarium'
            },
            cinema: {
            filters: [`["amenity"="cinema"]`],
            emoji: '🎬',
            label: 'Cinema'
            },
            embassy: {
            filters: [
                `["office"="diplomatic"]["diplomatic"="embassy"]`,
                `["amenity"="embassy"]`
            ],
            emoji: '🏛️',
            label: 'Embassy'
            },
            golf: {
            filters: [`["leisure"="golf_course"]`],
            emoji: '⛳',
            label: 'Golf Course'
            },
            hospital: {
            filters: [`["amenity"="hospital"]`],
            emoji: '🏥',
            label: 'Hospital'
            },
            airport: {
            filters: [
                `["aeroway"="aerodrome"]["aerodrome:type"="international"]`,
                `["aeroway"="aerodrome"]["iata"]`
            ],
            emoji: '✈️',
            label: 'International Airport'
            },
            library: {
            filters: [`["amenity"="library"]`],
            emoji: '📚',
            label: 'Library'
            },
            museum: {
            filters: [`["tourism"="museum"]`],
            emoji: '🖼️',
            label: 'Museum'
            },
            park: {
            filters: [`["leisure"="park"]`],
            emoji: '🌳',
            label: 'Park'
            },
            zoo: {
            filters: [`["tourism"="zoo"]`],
            emoji: '🦁',
            label: 'Zoo'
            }
        };

        const spec = poiSpecs[normalizedType];
        if (!spec) {
            console.warn(`Unbekannter POI-Typ: ${normalizedType}`);
            loader.classList.add('hidden');
            return;
        }

        // Ersetzt die bisherige buildQuery-Implementierung
        const buildQuery = (poly, filters) => {
        // Jedes Statement endet mit ;  → saubere Trennung in der Union
        const parts = [];
        for (const f of filters) {
            parts.push(`node(poly:"${poly}")${f};`);
            parts.push(`way(poly:"${poly}")${f};`);
            parts.push(`relation(poly:"${poly}")${f};`);
        }
        return `[out:json][timeout:60];(${parts.join('')});out center;`;
        };

        const query = buildQuery(polyString, spec.filters);

        try {
            const data = await fetchOverpassData(query);
            const makeEmojiPin = (emoji, extraClass = '') =>
            L.divIcon({
                className: `emoji-pin ${extraClass}`.trim(), // Container (32x44)
                html: `<div class="emoji-bubble"><span class="emoji" aria-hidden="true">${emoji}</span></div>`,
                iconSize: [32, 44],   // Gesamtgröße: 32 Kopf + 12 Spitze
                iconAnchor: [16, 44], // Spitze zeigt genau auf den Ort
                popupAnchor: [0, -38] // Popup über dem Kopf
            });

            const seen = new Set();

            data.elements.forEach((el) => {
            // dedupe per OSM-ID
            const id = el.id || `${el.type}:${el.id}`;
            if (id && seen.has(id)) return;
            if (id) seen.add(id);

            const lat = el.lat ?? el.center?.lat;
            const lon = el.lon ?? el.center?.lon;
            if (lat == null || lon == null) return;

            const name = el.tags?.name || el.tags?.['name:en'] || spec.label;
            const icon = makeEmojiPin(spec.emoji, `pin-${normalizedType}`);

            L.marker([lat, lon], { icon })
                .bindPopup(name)
                .addTo(layers.pois[normalizedType]);
            });

            map.addLayer(layers.pois[normalizedType]);
        } catch (e) {
            console.error(`Failed to fetch POIs for ${normalizedType}:`, e);
            alert(`Could not load POIs for ${spec.label}.`);
        } finally {
            loader.classList.add('hidden');
        }
    }

    /**
     * Füllt die Legende mit den gefundenen Linien zum Ein- und Ausblenden.
     */
    function populateLineLegend() {
        lineLegend.innerHTML = '';
        processedLines
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .forEach(line => {
                const label = document.createElement('label');
                label.className = 'legend-item';
                label.innerHTML = `<input type="checkbox" checked data-line-name="${line.name}"><span class="line-color-swatch" style="background-color: ${line.color};"></span>${line.name}`;
                
                line.stationIds.forEach(id => {
                    const marker = stationMarkers.get(id);
                    if (marker) {
                        marker.visibleCount++;
                        if (!layers.stations.hasLayer(marker)) {
                            layers.stations.addLayer(marker);
                        }
                    }
                });

                label.querySelector('input').addEventListener('change', (e) => {
                    const targetLine = processedLines.find(l => l.name === e.target.dataset.lineName);
                    if (!targetLine) return;

                    const toggleMarkers = (increment) => {
                        targetLine.stationIds.forEach(id => {
                            const marker = stationMarkers.get(id);
                            if (marker) {
                                marker.visibleCount += increment;
                                if (marker.visibleCount === 1 && increment === 1) {
                                    layers.stations.addLayer(marker);
                                } else if (marker.visibleCount === 0 && increment === -1) {
                                    layers.stations.removeLayer(marker);
                                }
                            }
                        });
                    };

                    if (e.target.checked) {
                        layers.lines.addLayer(targetLine.layer);
                        toggleMarkers(1);
                    } else {
                        layers.lines.removeLayer(targetLine.layer);
                        toggleMarkers(-1);
                    }
                });
                lineLegend.appendChild(label);
            });
    }

    /**
     * Generiert eine zufällige Hex-Farbe.
     * @returns {string} Ein Farbcode, z.B. "#A7C8E4".
     */
    function getRandomColor() {
        return `#${'000000'.concat(Math.floor(Math.random() * 16777215).toString(16)).slice(-6)}`;
    }
});