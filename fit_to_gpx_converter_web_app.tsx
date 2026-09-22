import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, Download, FileText, MapPin, Activity, ShieldCheck, 
  RefreshCw, CheckCircle, AlertTriangle, Moon, Sun, Info, Code, Zap,
  Layers, Trash2, Archive, FileCode, Check, Crosshair
} from 'lucide-react';

// Garmin FIT epoch offset (1989-12-31T00:00:00Z UTC)
const GARMIN_EPOCH_OFFSET = 631065600;
const SEMICIRCLE_TO_DEG = 180 / Math.pow(2, 31);

// Palette of colors for multi-track map overlays
const TRACK_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#6366f1'  // Indigo
];

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (isNaN(seconds) || seconds <= 0) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return [hrs, mins, secs]
    .map(v => v < 10 ? '0' + v : v)
    .join(':');
}

function fitTimestampToISO(fitTimestamp) {
  if (!fitTimestamp || isNaN(fitTimestamp)) return null;
  const date = new Date((fitTimestamp + GARMIN_EPOCH_OFFSET) * 1000);
  return date.toISOString();
}

function parseFitBinary(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);
  let offset = 0;

  if (arrayBuffer.byteLength < 14) {
    throw new Error('File is too small to be a valid Garmin .FIT file.');
  }

  const headerSize = dataView.getUint8(0);
  const dataSize = dataView.getUint32(4, true);

  const magic = String.fromCharCode(
    dataView.getUint8(8), dataView.getUint8(9),
    dataView.getUint8(10), dataView.getUint8(11)
  );

  if (magic !== '.FIT') {
    throw new Error('Invalid FIT format (missing ".FIT" magic signature).');
  }

  offset = headerSize;
  const endOffset = headerSize + dataSize;
  const localMessageDefinitions = {};
  const records = [];

  while (offset < endOffset && offset < arrayBuffer.byteLength) {
    const recordHeader = dataView.getUint8(offset);
    offset += 1;

    const isCompressedTimestamp = (recordHeader & 0x80) !== 0;
    if (isCompressedTimestamp) {
      const localMsgType = (recordHeader >> 5) & 0x03;
      const def = localMessageDefinitions[localMsgType];
      if (def) offset += def.size;
      continue;
    }

    const isDefinitionMessage = (recordHeader & 0x40) !== 0;
    const localMsgType = recordHeader & 0x0F;

    if (isDefinitionMessage) {
      offset += 1; // Reserved byte
      const architecture = dataView.getUint8(offset);
      const isLittleEndian = architecture === 0;
      offset += 1;

      const globalMessageNum = isLittleEndian ? 
        dataView.getUint16(offset, true) : 
        dataView.getUint16(offset, false);
      offset += 2;

      const numFields = dataView.getUint8(offset);
      offset += 1;

      const fieldDefinitions = [];
      let totalSize = 0;

      for (let i = 0; i < numFields; i++) {
        const fieldDefNum = dataView.getUint8(offset);
        const size = dataView.getUint8(offset + 1);
        const baseType = dataView.getUint8(offset + 2);
        offset += 3;

        fieldDefinitions.push({ fieldDefNum, size, baseType });
        totalSize += size;
      }

      if ((recordHeader & 0x20) !== 0) { // Developer fields
        const numDevFields = dataView.getUint8(offset);
        offset += 1;
        for (let i = 0; i < numDevFields; i++) {
          const size = dataView.getUint8(offset + 1);
          offset += 3;
          totalSize += size;
        }
      }

      localMessageDefinitions[localMsgType] = {
        globalMessageNum,
        isLittleEndian,
        fields: fieldDefinitions,
        size: totalSize
      };

    } else {
      const def = localMessageDefinitions[localMsgType];
      if (!def) break;

      const isLittleEndian = def.isLittleEndian;
      const recordObj = {};

      for (const field of def.fields) {
        const fieldVal = readFieldValue(dataView, offset, field.size, field.baseType, isLittleEndian);
        offset += field.size;

        if (def.globalMessageNum === 20) { // Record Message
          switch (field.fieldDefNum) {
            case 0: recordObj.position_lat = fieldVal; break;
            case 1: recordObj.position_long = fieldVal; break;
            case 2: recordObj.altitude = fieldVal; break;
            case 3: recordObj.heart_rate = fieldVal; break;
            case 4: recordObj.cadence = fieldVal; break;
            case 5: recordObj.distance = fieldVal; break;
            case 6: recordObj.speed = fieldVal; break;
            case 7: recordObj.power = fieldVal; break;
            case 13: recordObj.temperature = fieldVal; break;
            case 253: recordObj.timestamp = fieldVal; break;
            default: break;
          }
        }
      }

      if (def.globalMessageNum === 20 && recordObj.position_lat !== undefined && recordObj.position_long !== undefined) {
        const lat = recordObj.position_lat * SEMICIRCLE_TO_DEG;
        const lon = recordObj.position_long * SEMICIRCLE_TO_DEG;

        let ele = recordObj.altitude;
        if (ele !== undefined && ele !== null && ele > 10000) {
          ele = (ele / 5) - 500;
        }

        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && (lat !== 0 || lon !== 0)) {
          records.push({
            lat,
            lon,
            ele: ele !== undefined ? Number(ele.toFixed(2)) : null,
            timestamp: recordObj.timestamp ? fitTimestampToISO(recordObj.timestamp) : null,
            heartRate: recordObj.heart_rate || null,
            cadence: recordObj.cadence || null,
            speed: recordObj.speed ? Number((recordObj.speed / 1000 * 3.6).toFixed(2)) : null,
            temperature: recordObj.temperature || null,
            power: recordObj.power || null
          });
        }
      }
    }
  }

  if (records.length === 0) {
    throw new Error('No GPS coordinates found in this file.');
  }

  return records;
}

function readFieldValue(view, offset, size, baseType, isLittleEndian) {
  try {
    switch (baseType & 0x0F) {
      case 0: case 1: case 2: case 10: return view.getUint8(offset);
      case 3: return view.getInt16(offset, isLittleEndian);
      case 4: case 11: return view.getUint16(offset, isLittleEndian);
      case 5: return view.getInt32(offset, isLittleEndian);
      case 6: case 12: return view.getUint32(offset, isLittleEndian);
      case 8: return view.getFloat32(offset, isLittleEndian);
      case 9: return view.getFloat64(offset, isLittleEndian);
      default: return view.getUint8(offset);
    }
  } catch (e) {
    return 0;
  }
}

function createSyntheticFitFile(name, latOffset = 0, lonOffset = 0) {
  const numPoints = 50;
  const startLat = 37.7749 + latOffset;
  const startLon = -122.4194 + lonOffset;
  const startTimestamp = Math.floor(Date.now() / 1000) - GARMIN_EPOCH_OFFSET - (Math.random() * 86400);

  const headerSize = 14;
  const defMsgSize = 15;
  const dataMsgSize = 17;
  const totalDataSize = defMsgSize + (dataMsgSize * numPoints);
  const totalSize = headerSize + totalDataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  view.setUint8(0, 14);
  view.setUint8(1, 0x20);
  view.setUint16(2, 2000, true);
  view.setUint32(4, totalDataSize, true);
  view.setUint8(8, 0x2E); view.setUint8(9, 0x46); view.setUint8(10, 0x49); view.setUint8(11, 0x54);

  let offset = 14;

  view.setUint8(offset++, 0x40);
  view.setUint8(offset++, 0x00);
  view.setUint8(offset++, 0x00);
  view.setUint16(offset, 20, true); offset += 2;
  view.setUint8(offset++, 5);

  const fields = [
    { num: 0, size: 4, type: 5 },
    { num: 1, size: 4, type: 5 },
    { num: 2, size: 2, type: 4 },
    { num: 3, size: 1, type: 2 },
    { num: 253, size: 4, type: 6 }
  ];

  fields.forEach(f => {
    view.setUint8(offset++, f.num);
    view.setUint8(offset++, f.size);
    view.setUint8(offset++, f.type);
  });

  for (let i = 0; i < numPoints; i++) {
    const lat = startLat + (i * 0.0003) + (Math.sin(i / 4) * 0.0002);
    const lon = startLon + (i * 0.0004) + (Math.cos(i / 4) * 0.0002);
    const alt = 120 + Math.floor(Math.sin(i / 8) * 50);
    const hr = 125 + Math.floor(Math.sin(i / 3) * 30);
    const timestamp = startTimestamp + (i * 12);

    const latSemicircles = Math.round(lat / SEMICIRCLE_TO_DEG);
    const lonSemicircles = Math.round(lon / SEMICIRCLE_TO_DEG);

    view.setUint8(offset++, 0x00);
    view.setInt32(offset, latSemicircles, true); offset += 4;
    view.setInt32(offset, lonSemicircles, true); offset += 4;
    view.setUint16(offset, (alt + 500) * 5, true); offset += 2;
    view.setUint8(offset++, hr);
    view.setUint32(offset, timestamp, true); offset += 4;
  }

  return buffer;
}

function escapeXml(str) {
  if (!str) return '';
  return str.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function generateGpxXml(records, trackName = 'Garmin Activity', includeExtensions = true) {
  const name = escapeXml(trackName);
  const startTime = records.length > 0 && records[0].timestamp ? records[0].timestamp : new Date().toISOString();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<gpx version="1.1" creator="FIT to GPX Converter - Batch Browser Edition" `;
  xml += `xmlns="http://www.topografix.com/GPX/1/1" `;
  xml += `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `;
  if (includeExtensions) {
    xml += `xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" `;
  }
  xml += `xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n`;

  xml += `  <metadata>\n`;
  xml += `    <name>${name}</name>\n`;
  xml += `    <time>${startTime}</time>\n`;
  xml += `  </metadata>\n`;

  xml += `  <trk>\n`;
  xml += `    <name>${name}</name>\n`;
  xml += `    <trkseg>\n`;

  for (const p of records) {
    xml += `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n`;
    if (p.ele !== null && p.ele !== undefined) xml += `        <ele>${p.ele}</ele>\n`;
    if (p.timestamp) xml += `        <time>${p.timestamp}</time>\n`;

    if (includeExtensions && (p.heartRate || p.cadence || p.temperature || p.power)) {
      xml += `        <extensions>\n`;
      xml += `          <gpxtpx:TrackPointExtension>\n`;
      if (p.temperature !== null) xml += `            <gpxtpx:atemp>${p.temperature}</gpxtpx:atemp>\n`;
      if (p.heartRate !== null) xml += `            <gpxtpx:hr>${p.heartRate}</gpxtpx:hr>\n`;
      if (p.cadence !== null) xml += `            <gpxtpx:cad>${p.cadence}</gpxtpx:cad>\n`;
      if (p.power !== null) xml += `            <gpxtpx:power>${p.power}</gpxtpx:power>\n`;
      xml += `          </gpxtpx:TrackPointExtension>\n`;
      xml += `        </extensions>\n`;
    }
    xml += `      </trkpt>\n`;
  }

  xml += `    </trkseg>\n`;
  xml += `  </trk>\n`;
  xml += `</gpx>`;

  return xml;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateTrackStats(records) {
  if (!records || records.length === 0) return null;

  let totalDistanceMeters = 0;
  let elevationGain = 0;

  for (let i = 0; i < records.length; i++) {
    const pt = records[i];
    if (i > 0) {
      const prev = records[i - 1];
      totalDistanceMeters += haversineDistance(prev.lat, prev.lon, pt.lat, pt.lon);
      if (pt.ele !== null && prev.ele !== null) {
        const diff = pt.ele - prev.ele;
        if (diff > 0) elevationGain += diff;
      }
    }
  }

  const startTime = records[0].timestamp ? new Date(records[0].timestamp) : null;
  const endTime = records[records.length - 1].timestamp ? new Date(records[records.length - 1].timestamp) : null;
  const durationSec = (startTime && endTime) ? Math.max(0, (endTime - startTime) / 1000) : 0;

  return {
    pointCount: records.length,
    distanceKm: Number((totalDistanceMeters / 1000).toFixed(2)),
    distanceMiles: Number((totalDistanceMeters / 1609.34).toFixed(2)),
    durationSec,
    elevationGain: Math.round(elevationGain),
    startTime: startTime ? startTime.toLocaleDateString() + ' ' + startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A'
  };
}

function LeafletTrackMap({ fileItems, selectedId, showAllOverlaid, isDarkMode }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);

  useEffect(() => {
    if (!fileItems || fileItems.length === 0 || !mapContainerRef.current) return;

    const loadLeaflet = async () => {
      if (!window.L) {
        if (!document.getElementById('leaflet-css')) {
          const link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
          document.head.appendChild(link);
        }

        await new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
          script.onload = resolve;
          document.head.appendChild(script);
        });
      }

      const L = window.L;
      if (!L) return;

      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }

      const map = L.map(mapContainerRef.current, { zoomControl: true });
      mapInstanceRef.current = map;

      const tileUrl = isDarkMode 
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

      L.tileLayer(tileUrl, { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

      const itemsToRender = showAllOverlaid
        ? fileItems.filter(f => f.status === 'success' && f.records?.length > 0)
        : fileItems.filter(f => f.id === selectedId && f.status === 'success');

      if (itemsToRender.length === 0) return;

      const allBounds = [];

      itemsToRender.forEach((item, index) => {
        const color = TRACK_COLORS[index % TRACK_COLORS.length];
        const latLngs = item.records.map(p => [p.lat, p.lon]);
        
        const polyline = L.polyline(latLngs, {
          color,
          weight: 4,
          opacity: 0.85,
          lineJoin: 'round'
        }).addTo(map);

        polyline.bindPopup(`<b>${escapeXml(item.fileName)}</b><br/>Distance: ${item.stats?.distanceKm} km`);
        allBounds.push(polyline.getBounds());

        // Start / End Markers for each rendered line
        const startPt = item.records[0];
        const endPt = item.records[item.records.length - 1];

        const startIcon = L.divIcon({
          className: 'custom-map-marker',
          html: `<div style="background-color: ${color}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        });

        L.marker([startPt.lat, startPt.lon], { icon: startIcon }).addTo(map);
      });

      if (allBounds.length > 0) {
        const combinedBounds = allBounds.reduce((acc, bounds) => acc.extend(bounds), allBounds[0]);
        map.fitBounds(combinedBounds, { padding: [30, 30] });
      }
    };

    loadLeaflet().catch(err => console.error("Map render error:", err));

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [fileItems, selectedId, showAllOverlaid, isDarkMode]);

  return (
    <div className="relative w-full h-80 md:h-96 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-inner">
      <div ref={mapContainerRef} className="w-full h-full bg-slate-100 dark:bg-slate-900" />
      <div className="absolute top-3 right-3 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 shadow-sm z-[1000] border border-slate-200 dark:border-slate-800">
        {showAllOverlaid ? `Showing ${fileItems.filter(f=>f.status==='success').length} Overlaid Tracks` : 'Selected Track Preview'}
      </div>
    </div>
  );
}

export default function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [fileItems, setFileItems] = useState([]); // List of batch files
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [showAllTracksOnMap, setShowAllTracksOnMap] = useState(true);
  const [activeTab, setActiveTab] = useState('list'); // 'list', 'map', 'xml'
  const [unitSystem, setUnitSystem] = useState('metric');
  const [includeGarminExtensions, setIncludeGarminExtensions] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isZipping, setIsZipping] = useState(false);

  const fileInputRef = useRef(null);

  useEffect(() => {
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

  // Load external JSZip dynamically for batch ZIP downloads
  const loadJSZip = async () => {
    if (window.JSZip) return window.JSZip;
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => reject(new Error('Failed to load JSZip library'));
      document.head.appendChild(script);
    });
  };

  const processFiles = (files) => {
    const fileList = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.fit'));
    
    if (fileList.length === 0) return;

    fileList.forEach(file => {
      const fileId = Math.random().toString(36).substring(2, 9);
      const newEntry = {
        id: fileId,
        fileName: file.name,
        fileSize: file.size,
        status: 'parsing', // 'parsing', 'success', 'error'
        error: null,
        records: [],
        stats: null,
        gpxXml: ''
      };

      setFileItems(prev => [...prev, newEntry]);

      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const records = parseFitBinary(evt.target.result);
          const stats = calculateTrackStats(records);
          const gpxXml = generateGpxXml(records, file.name.replace(/\.fit$/i, ''), includeGarminExtensions);

          setFileItems(prev => prev.map(item => {
            if (item.id === fileId) {
              return { ...item, status: 'success', records, stats, gpxXml };
            }
            return item;
          }));

          setSelectedFileId(fileId);
        } catch (err) {
          setFileItems(prev => prev.map(item => {
            if (item.id === fileId) {
              return { ...item, status: 'error', error: err.message || 'Parsing failed' };
            }
            return item;
          }));
        }
      };

      reader.readAsArrayBuffer(file);
    });
  };

  const handleFileInput = (e) => {
    if (e.target.files) processFiles(e.target.files);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  };

  // Add Synthetic Sample Batch (3 files at once)
  const handleAddSampleBatch = () => {
    const samples = [
      { name: 'Trail_Run_Marin.fit', latOff: 0, lonOff: 0 },
      { name: 'Mountain_Cycle_Loop.fit', latOff: 0.015, lonOff: 0.012 },
      { name: 'Coastal_Hike_North.fit', latOff: -0.012, lonOff: -0.015 }
    ];

    samples.forEach(s => {
      const buffer = createSyntheticFitFile(s.name, s.latOff, s.lonOff);
      const fileId = Math.random().toString(36).substring(2, 9);

      try {
        const records = parseFitBinary(buffer);
        const stats = calculateTrackStats(records);
        const gpxXml = generateGpxXml(records, s.name.replace(/\.fit$/i, ''), includeGarminExtensions);

        setFileItems(prev => [...prev, {
          id: fileId,
          fileName: s.name,
          fileSize: buffer.byteLength,
          status: 'success',
          records,
          stats,
          gpxXml
        }]);

        setSelectedFileId(fileId);
      } catch (e) {
        console.error(e);
      }
    });
  };

  // Download single file
  const handleDownloadSingle = (item) => {
    if (!item.gpxXml) return;
    const blob = new Blob([item.gpxXml], { type: 'application/gpx+xml;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', item.fileName.replace(/\.fit$/i, '.gpx'));
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Batch Download as ZIP
  const handleDownloadAllZip = async () => {
    const successfulItems = fileItems.filter(f => f.status === 'success' && f.gpxXml);
    if (successfulItems.length === 0) return;

    setIsZipping(true);
    try {
      const JSZip = await loadJSZip();
      const zip = new JSZip();

      successfulItems.forEach(item => {
        const gpxName = item.fileName.replace(/\.fit$/i, '.gpx');
        zip.file(gpxName, item.gpxXml);
      });

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `Garmin_Converted_GPX_Batch_${new Date().toISOString().slice(0, 10)}.zip`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to generate ZIP. Downloading files individually instead.');
      successfulItems.forEach(item => handleDownloadSingle(item));
    } finally {
      setIsZipping(false);
    }
  };

  // Remove single file
  const handleRemoveFile = (id) => {
    setFileItems(prev => prev.filter(f => f.id !== id));
    if (selectedFileId === id) setSelectedFileId(null);
  };

  // Clear All
  const handleClearAll = () => {
    setFileItems([]);
    setSelectedFileId(null);
  };

  // Cumulative Stats
  const successfulCount = fileItems.filter(f => f.status === 'success').length;
  const totalDistanceKm = fileItems
    .filter(f => f.status === 'success' && f.stats)
    .reduce((sum, f) => sum + f.stats.distanceKm, 0);
  const totalElevationM = fileItems
    .filter(f => f.status === 'success' && f.stats)
    .reduce((sum, f) => sum + f.stats.elevationGain, 0);

  const selectedItem = fileItems.find(f => f.id === selectedFileId);

  return (
    <div className={`min-h-screen flex flex-col font-sans transition-colors duration-200 ${isDarkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      
      {/* Navbar Header */}
      <header className="sticky top-0 z-50 backdrop-blur-md bg-white/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800 px-4 lg:px-8 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="bg-gradient-to-tr from-blue-600 to-indigo-500 p-2.5 rounded-xl text-white shadow-md shadow-blue-500/20">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-none tracking-tight">FIT to GPX <span className="text-xs font-mono font-semibold bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded ml-1">Batch</span></h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Multi-File Client-Side Converter</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="hidden sm:flex items-center text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-full">
            <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
            100% Offline & Private
          </div>

          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-6 space-y-6">
        
        {/* Banner Privacy Notice */}
        <div className="bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-transparent border border-blue-500/20 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
          <div className="flex items-center space-x-3">
            <Info className="w-5 h-5 text-blue-500 shrink-0" />
            <p className="text-slate-600 dark:text-slate-300">
              Drag multiple Garmin files at once. All processing happens locally in browser memory.
            </p>
          </div>
          <button
            onClick={handleAddSampleBatch}
            className="inline-flex items-center space-x-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-xl transition shadow-sm whitespace-nowrap"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Add Batch Sample (3 FITs)</span>
          </button>
        </div>

        {/* Drag & Drop Multi-File Zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-6 md:p-8 text-center transition flex flex-col items-center justify-center cursor-pointer ${
            isDragging
              ? 'border-blue-500 bg-blue-500/5 scale-[0.99]'
              : 'border-slate-300 dark:border-slate-800 hover:border-blue-400 dark:hover:border-blue-500 bg-white dark:bg-slate-900/50'
          }`}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInput}
            accept=".fit,.FIT"
            multiple
            className="hidden"
          />
          
          <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-500 mb-3 shadow-sm border border-blue-100 dark:border-blue-900/50">
            <Upload className="w-6 h-6" />
          </div>

          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Drop multiple Garmin .FIT files here
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Or click to pick multiple files from your computer
          </p>
        </div>

        {/* Batch Active Panel */}
        {fileItems.length > 0 && (
          <div className="space-y-6">
            
            {/* Cumulative Summary Stats Header */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="grid grid-cols-3 gap-4 text-center md:text-left w-full md:w-auto">
                <div>
                  <p className="text-xs text-slate-400">Total Converted</p>
                  <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{successfulCount} / {fileItems.length}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Total Distance</p>
                  <p className="text-lg font-bold text-blue-500">
                    {unitSystem === 'metric' ? `${totalDistanceKm.toFixed(1)} km` : `${(totalDistanceKm * 0.621371).toFixed(1)} mi`}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Total Elev. Gain</p>
                  <p className="text-lg font-bold text-emerald-500">
                    {unitSystem === 'metric' ? `${totalElevationM} m` : `${Math.round(totalElevationM * 3.28084)} ft`}
                  </p>
                </div>
              </div>

              {/* Batch Action Buttons */}
              <div className="flex items-center space-x-2 w-full md:w-auto">
                <button
                  onClick={handleDownloadAllZip}
                  disabled={isZipping || successfulCount === 0}
                  className="flex-1 md:flex-initial inline-flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2.5 rounded-xl font-medium text-xs sm:text-sm transition shadow-md shadow-blue-500/20"
                >
                  <Archive className="w-4 h-4" />
                  <span>{isZipping ? 'Creating ZIP...' : 'Download All as ZIP'}</span>
                </button>

                <button
                  onClick={handleClearAll}
                  className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-red-500/10 hover:text-red-500 text-slate-500 transition"
                  title="Clear all files"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* View Tabs */}
            <div className="flex border-b border-slate-200 dark:border-slate-800 space-x-4 text-sm font-medium">
              <button
                onClick={() => setActiveTab('list')}
                className={`pb-3 px-1 border-b-2 transition flex items-center space-x-2 ${
                  activeTab === 'list'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                }`}
              >
                <Activity className="w-4 h-4" />
                <span>Batch File Queue ({fileItems.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('map')}
                className={`pb-3 px-1 border-b-2 transition flex items-center space-x-2 ${
                  activeTab === 'map'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                }`}
              >
                <MapPin className="w-4 h-4" />
                <span>Multi-Track Map</span>
              </button>

              {selectedItem && (
                <button
                  onClick={() => setActiveTab('xml')}
                  className={`pb-3 px-1 border-b-2 transition flex items-center space-x-2 ${
                    activeTab === 'xml'
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                  }`}
                >
                  <Code className="w-4 h-4" />
                  <span>Selected GPX Preview</span>
                </button>
              )}
            </div>

            {/* TAB 1: Queue File Table */}
            {activeTab === 'list' && (
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="p-3.5">Filename</th>
                        <th className="p-3.5">Status</th>
                        <th className="p-3.5">Distance</th>
                        <th className="p-3.5">Duration</th>
                        <th className="p-3.5">Points</th>
                        <th className="p-3.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {fileItems.map((item, index) => {
                        const isSelected = item.id === selectedFileId;
                        const trackColor = TRACK_COLORS[index % TRACK_COLORS.length];

                        return (
                          <tr 
                            key={item.id}
                            className={`transition hover:bg-slate-50/50 dark:hover:bg-slate-800/30 ${
                              isSelected ? 'bg-blue-500/5' : ''
                            }`}
                          >
                            <td className="p-3.5">
                              <div className="flex items-center space-x-2">
                                <span 
                                  className="w-2.5 h-2.5 rounded-full shrink-0" 
                                  style={{ backgroundColor: trackColor }} 
                                />
                                <span className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[180px] sm:max-w-xs">
                                  {item.fileName}
                                </span>
                                <span className="text-[10px] text-slate-400">
                                  ({formatFileSize(item.fileSize)})
                                </span>
                              </div>
                            </td>

                            <td className="p-3.5">
                              {item.status === 'parsing' && (
                                <span className="inline-flex items-center text-amber-500 text-xs font-medium">
                                  Parsing...
                                </span>
                              )}
                              {item.status === 'success' && (
                                <span className="inline-flex items-center text-emerald-500 text-xs font-medium">
                                  <Check className="w-3.5 h-3.5 mr-1" /> Converted
                                </span>
                              )}
                              {item.status === 'error' && (
                                <span className="inline-flex items-center text-red-500 text-xs font-medium" title={item.error}>
                                  <AlertTriangle className="w-3.5 h-3.5 mr-1" /> Failed
                                </span>
                              )}
                            </td>

                            <td className="p-3.5 font-mono text-slate-700 dark:text-slate-300">
                              {item.stats ? (unitSystem === 'metric' ? `${item.stats.distanceKm} km` : `${item.stats.distanceMiles} mi`) : '--'}
                            </td>

                            <td className="p-3.5 font-mono text-slate-700 dark:text-slate-300">
                              {item.stats ? formatDuration(item.stats.durationSec) : '--'}
                            </td>

                            <td className="p-3.5 text-slate-600 dark:text-slate-400">
                              {item.stats ? item.stats.pointCount : '--'}
                            </td>

                            <td className="p-3.5 text-right space-x-1">
                              {item.status === 'success' && (
                                <>
                                  <button
                                    onClick={() => { setSelectedFileId(item.id); setActiveTab('map'); }}
                                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-blue-500/10 text-blue-500 transition"
                                    title="View on Map"
                                  >
                                    <Crosshair className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDownloadSingle(item)}
                                    className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition"
                                    title="Download GPX"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                              <button
                                onClick={() => handleRemoveFile(item.id)}
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-red-500/10 text-slate-400 hover:text-red-500 transition"
                                title="Remove File"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 2: Multi-Track Map */}
            {activeTab === 'map' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 text-xs">
                  <label className="flex items-center space-x-2 cursor-pointer font-medium text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={showAllTracksOnMap}
                      onChange={(e) => setShowAllTracksOnMap(e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500"
                    />
                    <span>Overlay All Successful Tracks ({fileItems.filter(f=>f.status==='success').length})</span>
                  </label>

                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400">Select Track Focus:</span>
                    <select
                      value={selectedFileId || ''}
                      onChange={(e) => { setSelectedFileId(e.target.value); setShowAllTracksOnMap(false); }}
                      className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 text-slate-800 dark:text-slate-200 font-medium"
                    >
                      {fileItems.filter(f => f.status === 'success').map(f => (
                        <option key={f.id} value={f.id}>{f.fileName}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <LeafletTrackMap 
                  fileItems={fileItems} 
                  selectedId={selectedFileId} 
                  showAllOverlaid={showAllTracksOnMap} 
                  isDarkMode={isDarkMode} 
                />
              </div>
            )}

            {/* TAB 3: Selected GPX Code Preview */}
            {activeTab === 'xml' && selectedItem && (
              <div className="relative">
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-2xl text-xs font-mono overflow-x-auto max-h-96 border border-slate-800">
                  {selectedItem.gpxXml}
                </pre>
                <button
                  onClick={() => navigator.clipboard?.writeText(selectedItem.gpxXml)}
                  className="absolute top-3 right-3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
                >
                  Copy XML
                </button>
              </div>
            )}

          </div>
        )}

      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-200 dark:border-slate-800 py-4 px-4 text-center text-xs text-slate-500 dark:text-slate-400">
        FIT to GPX Batch Converter &bull; Client-side processing &bull; Private & Secure
      </footer>

    </div>
  );
}