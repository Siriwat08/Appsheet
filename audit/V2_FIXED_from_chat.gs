/**
 * ============================================================================
 * OPTIMIZED ROUTING SCRIPT — PRO VERSION 2.0 (FIXED)
 * ============================================================================
 * [ARCHIVED FOR AUDIT] — โค้ดฉบับนี้คือ V2 ที่ AI ท่านอื่นส่งมาในแชท
 * เก็บไว้เพื่อการตรวจสอบ/เปรียบเทียบเท่านั้น — **ห้ามนำไปใช้งานจริง**
 * ให้ใช้ "OPTIMIZED ROUTING SCRIPT PRO VERSION 3.gs" (ฉบับตรวจแก้แล้ว) แทน
 *
 * ผลตรวจรับ (audit) พบข้อบกพร่อง 4 จุดใน V2 (ดูรายละเอียดใน audit/AUDIT_REPORT_V2.md):
 *  [A1] Cache hit คืนผลก่อนเขียนชีต + cache key ไม่มี rowId
 *       → shipment เดิมแถวใหม่ได้ "Success" แต่ชีตแถวนั้นว่างเปล่า (บั๊กใหม่ที่ V2 ใส่เข้ามา)
 *  [A2] ตรวจคอลัมน์ Lat/Long_01..20 แค่ "มีครบ" (presence) ไม่ตรวจ "ติดกัน" (contiguity)
 *       → ถ้ามีคอลัมน์แทรกกลาง batch write ยังเขียนทับคอลัมน์แทรกอยู่ดี
 *  [A3] validateCoord_ รับค่าหลัง parseFloat ซึ่ง parse บางส่วนได้
 *       → "14.16-46106" ให้ lat=14.16 ผ่าน validate ทุกด่าน = พิกัดผิดแบบเงียบยังหลุด
 *  [A4] Block read min→max row ไม่มี guard ช่วงแถว
 *       → match กระจาย (แถว 2 กับ 48000) = อ่าน 47,999 แถว x ทุกคอลัมน์ (memory heavy)
 * ============================================================================
 */

// =================================================================
// [ 1 ] CONFIGURATION
// =================================================================
const SPREADSHEET_ID_DEFAULT = "1CYtLpXn6gNYgbGu3oRF8CW5KkGYHQJ6D4jl9u2LiR6o";
const SHEET_COMPUTED = "SCGนครหลวงJWDภูมิภาค";
const SHEET_RESULT = "ทำเบิกส่วนต่างScgวังน้อย";

const DEPOT_COORDS = {
  lat: 14.1646106,
  lng: 100.6254644,
  name: "คลังสินค้า เอสซีจี เจดับเบิ้ลยูดี วังน้อย"
};

const COL_SHIPMENT = "Shipment No";
const COL_LATLNG = "จุดส่งสินค้าปลายทาง";
const COL_NAME = "ชื่อปลายทาง";
const COL_DEPOT_DISTANCE = "ระยะทางจากคลัง_Km";

const RESULT_ID_COLUMN = "ID_ทำเบิกส่วนต่างScgวังน้อย";
const RESULT_FIRST_DEST_COLUMN = "Lat/Long_ปลายทาง_01";
const RESULT_COLUMN_NAME = "GoogleMapsRoutesAPI";
const DISTANCE_COLUMN_NAME = "ระยะทาง_GoogleMapAPI_Km";
const LINK_COLUMN_NAME = "แสดงแผนที่_GoogleMapsRoutesAPI";
const DURATION_COLUMN_NAME = "เวลาเดินทาง_นาที_GoogleMapAPI";

const STATUS_COLUMN_NAME = "Routing_Status";
const WARNING_COLUMN_NAME = "Route_Warning";

const MAX_DEST_COLUMNS = 20;
const API_MAX_INTERMEDIATES = 25;
const API_RETRY_MAX = 3;
const CACHE_TTL_SECONDS = 21600;

const THAI_LAT = { min: 5, max: 21 };
const THAI_LNG = { min: 97, max: 106 };

// =================================================================
// [ 2 ] ENTRY POINT
// =================================================================
function findOptimalRouteUsingExistingDistance(shipmentId, rowId) {
  try {
    Logger.log(`--- Starting PRO 2.0 Calculation | Shipment: ${shipmentId}, Row: ${rowId} ---`);

    // ⚠️ [A1] จุดบกพร่อง: cache hit → return ทันที "ก่อน" writeResultsPro_
    //         และ key ไม่มี rowId — แถวใหม่ของ shipment เดิมจะไม่ถูกเขียนชีตเลย
    const cache = CacheService.getScriptCache();
    const cacheKey = `route_${String(shipmentId).trim()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      Logger.log(`♻️ Cache hit for shipment ${shipmentId}`);
      return JSON.parse(cached);   // <<< ออกก่อนถึง writeResultsPro_ !
    }

    const ss = openTargetSpreadsheet_();

    const prep = prepareWaypointsPro_(ss, shipmentId);
    if (prep.points.length <= 1) {
      failWithWarnings_(prep.warnings,
        `No valid waypoints found for Shipment: ${shipmentId} (พิกัดเสีย/ถูกข้าม: ${prep.skipped} จุด)`);
    }

    const orderedPoints = orderPoints_(prep.points);
    const result = executeGoogleMapsRoutesAPIOneWay(orderedPoints);

    const resultSheet = requireSheet_(ss, SHEET_RESULT);
    writeResultsPro_(resultSheet, rowId, result, prep.warnings);

    const ret = {
      Status: "Success",
      CalculatedDistanceKm: result.totalDistance,
      GoogleMapsLink: result.googleMapsLink,
      WaypointsUsed: result.orderedWaypoints.length - 1,
      SkippedInvalid: prep.skipped,
      Warnings: prep.warnings
    };
    cache.put(cacheKey, JSON.stringify(ret), CACHE_TTL_SECONDS);
    return ret;

  } catch (error) {
    Logger.log(`❌ Error: ${error.message}\n${error.stack}`);
    throw error;
  }
}

function clearRouteCache(shipmentId) {
  if (!shipmentId) { Logger.log("ระบุ shipmentId"); return; }
  CacheService.getScriptCache().remove(`route_${String(shipmentId).trim()}`);
}

// =================================================================
// [ 3 ] HELPERS
// =================================================================
function openTargetSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || SPREADSHEET_ID_DEFAULT;
  return SpreadsheetApp.openById(id);
}

function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error(`ไม่พบชีต: "${name}"`);
  return sheet;
}

function getHeaderIndexMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) throw new Error(`ชีต "${sheet.getName()}" ไม่มีข้อมูลเลย`);
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const map = {};
  header.forEach((name, idx) => { if (name && map[name] === undefined) map[name] = idx + 1; });
  return { header, map };
}

function findRowByValue_(sheet, colIdx, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const range = sheet.getRange(2, colIdx, lastRow - 1, 1);
  const found = range.createTextFinder(String(value).trim()).matchEntireCell(true).findNext();
  return found ? found.getRow() : null;
}

function formatLatLng_(point, withSpace) {
  const sep = withSpace ? ", " : ",";
  return `${point.original.lat.toFixed(6)}${sep}${point.original.lng.toFixed(6)}`;
}

// ⚠️ [A3] จุดบกพร่อง: รับค่าหลัง parseFloat ซึ่ง parse บางส่วน —
//         "14.16-46106" → lat=14.16 ผ่านทั้งช่วงโลกและช่วงกล่องไทย
function validateCoord_(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: "ไม่ใช่ตัวเลข" };
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, reason: "นอกช่วงโลกจริง" };
  if (lat === 0 && lng === 0) return { ok: false, reason: "พิกัด (0,0)" };
  const outOfThailand = lat < THAI_LAT.min || lat > THAI_LAT.max || lng < THAI_LNG.min || lng > THAI_LNG.max;
  return { ok: true, outOfThailand };
}

function haversineKm_(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function failWithWarnings_(warnings, message) {
  const detail = warnings.length ? `\nWarnings:\n - ${warnings.join("\n - ")}` : "";
  throw new Error(message + detail);
}

// =================================================================
// [ 4 ] DATA PREPARATION
// =================================================================
function prepareWaypointsPro_(ss, shipmentId) {
  const computedSheet = requireSheet_(ss, SHEET_COMPUTED);
  const { map } = getHeaderIndexMap_(computedSheet);

  const shipmentCol = map[COL_SHIPMENT];
  const latlngCol = map[COL_LATLNG];
  const nameCol = map[COL_NAME];
  const distanceCol = map[COL_DEPOT_DISTANCE];

  if (!shipmentCol || !latlngCol) {
    throw new Error(`Missing required columns in "${SHEET_COMPUTED}"`);
  }

  const lastRow = computedSheet.getLastRow();
  if (lastRow < 2) return { points: [], warnings: [], skipped: 0 };

  const searchRange = computedSheet.getRange(2, shipmentCol, lastRow - 1, 1);
  const matches = searchRange.createTextFinder(String(shipmentId).trim())
    .matchEntireCell(true).findAll();

  const warnings = [];
  let skipped = 0;
  if (!matches.length) return { points: [], warnings, skipped };

  // ⚠️ [A4] จุดบกพร่อง: block read min→max ไม่มี guard ช่วงแถว —
  //         match กระจายหลายหมื่นแถว = อ่านบล็อกมหึมาครั้งเดียว
  const rowIdxs = matches.map(m => m.getRow()).sort((a, b) => a - b);
  const minRow = rowIdxs[0], maxRow = rowIdxs[rowIdxs.length - 1];
  const lastCol = computedSheet.getLastColumn();
  const block = computedSheet.getRange(minRow, 1, maxRow - minRow + 1, lastCol).getValues();
  const rowMap = {};
  rowIdxs.forEach(r => { rowMap[r] = block[r - minRow]; });

  const points = [{
    id: 0,
    name: DEPOT_COORDS.name,
    original: { lat: DEPOT_COORDS.lat, lng: DEPOT_COORDS.lng },
    forApi: { location: { latLng: { latitude: DEPOT_COORDS.lat, longitude: DEPOT_COORDS.lng } } },
    distance: 0,
    isDepot: true
  }];
  let idCounter = 1;
  const seen = {};

  rowIdxs.forEach(rowIdx => {
    const row = rowMap[rowIdx];
    const latlngRaw = row[latlngCol - 1];
    if (!latlngRaw) { skipped++; warnings.push(`แถว ${rowIdx}: พิกัดว่าง → ข้าม`); return; }

    const cleaned = String(latlngRaw).trim().replace(/[^\d.,-]/g, "");
    const parts = cleaned.split(",");
    if (parts.length !== 2) {
      skipped++; warnings.push(`แถว ${rowIdx}: รูปแบบพิกัดผิด "${latlngRaw}" → ข้าม`);
      return;
    }
    const lat = parseFloat(parts[0].trim());   // ⚠️ [A3] parseFloat แบบ partial-parse
    const lng = parseFloat(parts[1].trim());
    const v = validateCoord_(lat, lng);
    if (!v.ok) {
      skipped++; warnings.push(`แถว ${rowIdx}: พิกัดไม่ถูกต้อง (${v.reason}) → ข้าม`);
      return;
    }
    if (v.outOfThailand) {
      warnings.push(`แถว ${rowIdx}: พิกัดนอกกล่องประเทศไทย — ยังใช้ต่อ แต่ควรตรวจสอบ`);
    }

    let distance = null, distanceSource = "sheet";
    if (distanceCol) {
      const raw = row[distanceCol - 1];
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) distance = parsed;
      else warnings.push(`แถว ${rowIdx}: ค่า "${COL_DEPOT_DISTANCE}" = "${raw}" ใช้ไม่ได้ → ใช้ Haversine แทน`);
    }
    if (distance === null) {
      distance = haversineKm_(DEPOT_COORDS.lat, DEPOT_COORDS.lng, lat, lng);
      distanceSource = "haversine";
    }

    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    const name = (nameCol && row[nameCol - 1]) ? String(row[nameCol - 1]).trim() : `Point ${idCounter}`;

    if (seen[key]) {
      warnings.push(`แถว ${rowIdx}: พิกัดซ้ำกับ "${seen[key].name}" → รวมเป็นจุดเดียว`);
      seen[key].name += ` / ${name}`;
      return;
    }

    const point = {
      id: idCounter++, name,
      original: { lat, lng },
      forApi: { location: { latLng: { latitude: lat, longitude: lng } } },
      distance, distanceSource,
      isDepot: false
    };
    seen[key] = point;
    points.push(point);
  });

  return { points, warnings, skipped };
}

// =================================================================
// [ 5 ] SORTING
// =================================================================
function orderPoints_(allPoints) {
  const depot = allPoints[0];
  const destinations = allPoints.slice(1);
  destinations.sort((a, b) => (b.distance - a.distance) || (a.id - b.id));
  const finalDestination = destinations[0];
  const intermediates = destinations.slice(1);
  return [depot, ...intermediates, finalDestination];
}

// =================================================================
// [ 6 ] API EXECUTION
// =================================================================
function executeGoogleMapsRoutesAPIOneWay(allPoints) {
  const GOOGLE_MAPS_API_KEY = PropertiesService.getScriptProperties().getProperty("GOOGLE_MAPS_API_KEY");
  if (!GOOGLE_MAPS_API_KEY) throw new Error("Google Maps API Key not set in Script Properties");

  const origin = allPoints[0];
  const finalDestination = allPoints[allPoints.length - 1];
  const intermediates = allPoints.slice(1, -1);

  if (intermediates.length > API_MAX_INTERMEDIATES) {
    throw new Error(`จุดส่งระหว่างกลาง ${intermediates.length} จุด เกินขีดจำกัด Routes API (${API_MAX_INTERMEDIATES})`);
  }
  const shouldOptimize = intermediates.length > 1;

  const payload = {
    origin: origin.forApi,
    destination: finalDestination.forApi,
    intermediates: intermediates.map(p => p.forApi),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    optimizeWaypointOrder: shouldOptimize
  };

  const apiUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex,routes.legs.duration'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = fetchWithRetry_(apiUrl, options);
  const rawText = response.getContentText();
  let result;
  try {
    result = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Routes API ตอบกลับไม่ใช่ JSON: ${rawText.substring(0, 300)}`);
  }

  if (!result.routes || result.routes.length === 0) {
    throw new Error(`Routes API ไม่พบเส้นทาง (routes ว่าง) | Response: ${rawText.substring(0, 500)}`);
  }

  const route = result.routes[0];
  const totalDistance = Math.round((route.distanceMeters || 0) / 1000 * 100) / 100;
  const totalMinutes = route.duration ? Math.round(parseFloat(route.duration.replace(/s$/, "")) / 60) : null;

  const orderedWaypoints = [origin];
  let usedOptimized = false;
  if (shouldOptimize && Array.isArray(route.optimizedIntermediateWaypointIndex)) {
    const idx = route.optimizedIntermediateWaypointIndex;
    const valid = idx.every(i => Number.isInteger(i) && intermediates[i]);
    if (valid && idx.length === intermediates.length) {
      idx.forEach(i => orderedWaypoints.push(intermediates[i]));
      usedOptimized = true;
    }
  }
  if (!usedOptimized) orderedWaypoints.push(...intermediates);
  orderedWaypoints.push(finalDestination);

  const linkCoordinates = orderedWaypoints.map(p => formatLatLng_(p, false));
  const googleMapsLink = encodeURI(`https://www.google.com/maps/dir/${linkCoordinates.join('/')}`);

  return { orderedWaypoints, totalDistance, totalMinutes, googleMapsLink };
}

function fetchWithRetry_(url, options) {
  let waitMs = 2000;
  let lastResp = null;
  for (let attempt = 1; attempt <= API_RETRY_MAX; attempt++) {
    lastResp = UrlFetchApp.fetch(url, options);
    const code = lastResp.getResponseCode();
    if (code === 200) return lastResp;
    if (code === 429 || code >= 500) {
      if (attempt < API_RETRY_MAX) { Utilities.sleep(waitMs); waitMs *= 2; continue; }
    }
    break;
  }
  throw new Error(`Routes API Error ${lastResp.getResponseCode()}: ${lastResp.getContentText().substring(0, 500)}`);
}

// =================================================================
// [ 7 ] WRITE RESULTS
// =================================================================
function writeResultsPro_(resultSheet, rowId, result, warnings) {
  const { map } = getHeaderIndexMap_(resultSheet);

  const idCol = map[RESULT_ID_COLUMN];
  if (!idCol) throw new Error(`ไม่พบคอลัมน์ ID "${RESULT_ID_COLUMN}"`);

  const rowIndexInSheet = findRowByValue_(resultSheet, idCol, rowId);
  if (!rowIndexInSheet) throw new Error(`ไม่พบแถวสำหรับ ID: ${rowId}`);

  const mainCol = map[RESULT_COLUMN_NAME];
  const distCol = map[DISTANCE_COLUMN_NAME];
  const linkCol = map[LINK_COLUMN_NAME];
  const durationCol = map[DURATION_COLUMN_NAME];
  const firstDestCol = map[RESULT_FIRST_DEST_COLUMN];
  const statusCol = map[STATUS_COLUMN_NAME];
  const warnCol = map[WARNING_COLUMN_NAME];

  const missing = [];
  if (!mainCol) missing.push(RESULT_COLUMN_NAME);
  if (!distCol) missing.push(DISTANCE_COLUMN_NAME);
  if (!linkCol) missing.push(LINK_COLUMN_NAME);
  if (!firstDestCol) missing.push(RESULT_FIRST_DEST_COLUMN);
  if (missing.length) {
    throw new Error(`ไม่พบคอลัมน์ผลลัพธ์: ${missing.join(", ")}`);
  }

  const resultString = result.orderedWaypoints.map(p => formatLatLng_(p, true)).join(" | ");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    resultSheet.getRange(rowIndexInSheet, mainCol).setValue(resultString);
    resultSheet.getRange(rowIndexInSheet, distCol).setValue(result.totalDistance);
    resultSheet.getRange(rowIndexInSheet, linkCol).setValue(result.googleMapsLink);
    if (durationCol && result.totalMinutes !== null) {
      resultSheet.getRange(rowIndexInSheet, durationCol).setValue(result.totalMinutes);
    }

    // ⚠️ [A2] จุดบกพร่อง: ตรวจแค่ "ทุกหัวคอลัมน์มีอยู่" (presence)
    //         ไม่ตรวจว่า "เลขคอลัมน์ติดกัน" (contiguity) — คอลัมน์แทรกจะถูกเขียนทับ
    const destHeaders = [];
    for (let i = 1; i <= MAX_DEST_COLUMNS; i++) {
      destHeaders.push(`${RESULT_FIRST_DEST_COLUMN.replace(/01$/, '')}${String(i).padStart(2, '0')}`);
    }
    const destCols = destHeaders.map(h => map[h]);
    const allPresent = destCols.every(c => c !== undefined) && destCols[0] !== undefined;
    if (allPresent) {
      const customersOnly = result.orderedWaypoints.slice(1);
      if (customersOnly.length > MAX_DEST_COLUMNS) {
        warnings.push(`จุดส่ง ${customersOnly.length} จุด เกิน ${MAX_DEST_COLUMNS} ช่อง`);
      }
      const valuesToWrite = new Array(MAX_DEST_COLUMNS).fill('');
      customersOnly.slice(0, MAX_DEST_COLUMNS).forEach((p, i) => {
        valuesToWrite[i] = formatLatLng_(p, true);
      });
      resultSheet.getRange(rowIndexInSheet, destCols[0], 1, MAX_DEST_COLUMNS).setValues([valuesToWrite]);
    } else {
      const found = destCols.filter(c => c !== undefined).length;
      warnings.push(`คอลัมน์ Lat/Long_ปลายทาง ไม่ครบ (เจอ ${found}/${MAX_DEST_COLUMNS}) → ข้ามการเขียนแยกรายจุด`);
    }

    if (statusCol) resultSheet.getRange(rowIndexInSheet, statusCol).setValue("OK");
    if (warnCol) resultSheet.getRange(rowIndexInSheet, warnCol).setValue(
      warnings.length ? warnings.join(" | ") : ""
    );
  } finally {
    lock.releaseLock();
  }
}
