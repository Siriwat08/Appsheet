/**
 * ============================================================================
 * OPTIMIZED ROUTING SCRIPT — PRO VERSION 3.0 (AUDITED & VERIFIED)
 * ============================================================================
 * เวอร์ชันนี้ = V2 (FIXED) ของ AI ท่านอื่น + การตรวจรับรอบสุดท้าย (final audit)
 * แก้ข้อบกพร่อง 4 จุดที่ยังหลงเหลือ/ถูกใส่เข้ามาใหม่ใน V2:
 *
 *  [FIX-A1] Cache: V2 คืนผลจาก cache "ก่อน" เขียนชีต และ key ไม่มี rowId
 *           → แถวใหม่ของ shipment เดิมได้ Status:Success แต่เซลล์ว่างเปล่า
 *           V3: cache เก็บเฉพาะ "ผลจาก API" (route result) — การเขียนชีต
 *           ทำทุกครั้งตาม rowId เสมอ ไม่ว่าจะ cache hit หรือไม่
 *
 *  [FIX-A2] Batch write 20 คอลัมน์: V2 ตรวจแค่ว่าหัวคอลัมน์ "มีครบ" (presence)
 *           แต่ไม่ตรวจว่าเลขคอลัมน์ "ติดกัน" (contiguity)
 *           → ถ้ามีคอลัมน์อื่นแทรกกลาง batch write จะเขียนทับคอลัมน์แทรก
 *           V3: ตรวจ contiguity ก่อน — ถ้าติดกันใช้ batch write (เร็ว),
 *           ถ้าไม่ติดกันถอยไปเขียนทีละเซลล์ตามตำแหน่งจริง (ถูกต้องเสมอ)
 *
 *  [FIX-A3] พิกัด: V2 ใช้ parseFloat ซึ่ง parse บางส่วนได้ —
 *           "14.16-46106" → lat=14.16 ผ่าน validate ทุกด่าน (พิกัดผิดแบบเงียบ)
 *           V3: ตรวจ regex เข้มงวดทีละส่วน ^-?\d{1,3}(\.\d+)?$ ก่อน parseFloat
 *
 *  [FIX-A4] Block read: V2 อ่านบล็อก minRow→maxRow โดยไม่มี guard —
 *           ถ้า match กระจาย (แถว 2 กับ 48,000) จะอ่าน 47,999 แถวทุกคอลัมน์
 *           V3: อ่านเป็น "cluster" — จับกลุ่มแถวที่อยู่ใกล้กัน (gap ≤ 50)
 *           แล้วอ่านเฉพาะบล็อกของแต่ละกลุ่ม + อ่านเฉพาะคอลัมน์ที่ใช้จริง
 *
 * สิ่งที่ "คงไว้ตามเดิม" (business rules — ห้ามเปลี่ยนโดยไม่มีการอนุมัติ):
 *  - routingPreference: TRAFFIC_UNAWARE (ผลคงที่ ตรวจสอบย้อนหลังได้ — งานเบิกส่วนต่าง)
 *  - จุดไกลสุดจากคลัง = ปลายทางสุดท้าย (one-way, ไม่วนกลับคลัง)
 *  - optimizeWaypointOrder เฉพาะจุดระหว่างกลาง
 *
 * สิ่งที่ "รับมาจาก V2" (ของดีที่ V2 แก้ถูกต้องแล้ว):
 *  - Batch read แทน N+1 (แต่เพิ่ม cluster guard)
 *  - Header map แทนการค้นหาซ้ำ / ชื่อคอลัมน์เป็น constant ทั้งหมด
 *  - fetchWithRetry_ + exponential backoff (429/5xx)
 *  - ตรวจ routes[] ว่างก่อนใช้งาน / ตรวจ optimizedIntermediateWaypointIndex ครบ
 *  - LockService ครอบการเขียน / Warning & Status columns / รวมพิกัดซ้ำ
 *  - API key + Spreadsheet ID จาก Script Properties
 *  - เวลาเดินทาง (นาที) จาก route.duration
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

// --- คอลัมน์ชีต SOURCE (SCGนครหลวงJWDภูมิภาค) ---
const COL_SHIPMENT = "Shipment No";
const COL_LATLNG = "จุดส่งสินค้าปลายทาง";
const COL_NAME = "ชื่อปลายทาง";
const COL_DEPOT_DISTANCE = "ระยะทางจากคลัง_Km";

// --- คอลัมน์ชีต RESULT (ทำเบิกส่วนต่างScgวังน้อย) ---
const RESULT_ID_COLUMN = "ID_ทำเบิกส่วนต่างScgวังน้อย";
const RESULT_FIRST_DEST_COLUMN = "Lat/Long_ปลายทาง_01";
const RESULT_COLUMN_NAME = "GoogleMapsRoutesAPI";
const DISTANCE_COLUMN_NAME = "ระยะทาง_GoogleMapAPI_Km";
const LINK_COLUMN_NAME = "แสดงแผนที่_GoogleMapsRoutesAPI";
const DURATION_COLUMN_NAME = "เวลาเดินทาง_นาที_GoogleMapAPI";   // สร้างเพิ่มถ้าต้องการเวลาเดินทาง (optional)
const STATUS_COLUMN_NAME = "Routing_Status";                     // optional
const WARNING_COLUMN_NAME = "Route_Warning";                     // optional

const MAX_DEST_COLUMNS = 20;
const API_MAX_INTERMEDIATES = 25;     // ลิมิต intermediates ของ Routes API
const API_RETRY_MAX = 3;
const CACHE_TTL_SECONDS = 21600;      // 6 ชั่วโมง
const BLOCK_READ_MAX_GAP = 50;        // [FIX-A4] gap แถวสูงสุดที่ยอมอ่านรวมใน block เดียว

// ช่วงพิกัดประเทศไทย (ใช้เตือน ไม่ตัดทิ้ง)
const THAI_LAT = { min: 5, max: 21 };
const THAI_LNG = { min: 97, max: 106 };

// [FIX-A3] regex เข้มงวด: ตัวเลขล้วน มีจุดทศนิยมได้จุดเดียว มีลบนำหน้าได้
const COORD_PART_REGEX = /^-?\d{1,3}(\.\d+)?$/;

// =================================================================
// [ 2 ] ENTRY POINT — เรียกจาก AppSheet Bot
// =================================================================
function findOptimalRouteUsingExistingDistance(shipmentId, rowId) {
  try {
    Logger.log(`--- Starting PRO 3.0 Calculation | Shipment: ${shipmentId}, Row: ${rowId} ---`);

    if (!shipmentId || !rowId) {
      throw new Error(`พารามิเตอร์ไม่ครบ: shipmentId="${shipmentId}", rowId="${rowId}"`);
    }

    const ss = openTargetSpreadsheet_();

    // [FIX-A1] cache เก็บเฉพาะ "ผลจาก API" — การเขียนชีตทำเสมอทุกครั้ง
    const cache = CacheService.getScriptCache();
    const cacheKey = `routeApi_${String(shipmentId).trim()}`;
    let result = null;
    let warnings = [];
    let skipped = 0;
    let fromCache = false;

    const cached = cache.get(cacheKey);
    if (cached) {
      try {
        const c = JSON.parse(cached);
        // ตรวจโครงสร้างก่อนใช้ — cache เสียหาย → คำนวณใหม่
        if (c && Array.isArray(c.orderedWaypoints) && typeof c.totalDistance === "number" && c.googleMapsLink) {
          result = c;
          warnings = Array.isArray(c.cachedWarnings) ? c.cachedWarnings.slice() : [];
          skipped = c.cachedSkipped || 0;
          fromCache = true;
          Logger.log(`♻️ Cache hit (API result) for shipment ${shipmentId} — ข้ามการยิง API แต่ยังเขียนชีตตาม rowId ปกติ`);
        }
      } catch (e) {
        Logger.log(`⚠️ Cache เสียหาย (${e.message}) → คำนวณใหม่`);
      }
    }

    if (!result) {
      const prep = prepareWaypointsPro_(ss, shipmentId);
      warnings = prep.warnings;
      skipped = prep.skipped;

      if (prep.points.length <= 1) {
        failWithWarnings_(warnings,
          `No valid waypoints found for Shipment: ${shipmentId} (พิกัดเสีย/ถูกข้าม: ${skipped} จุด)`);
      }
      if (warnings.length) {
        Logger.log(`⚠️ รวม warning ${warnings.length} รายการ:\n - ${warnings.join("\n - ")}`);
      }

      const orderedPoints = orderPoints_(prep.points);
      result = executeGoogleMapsRoutesAPIOneWay(orderedPoints);

      // cache เฉพาะผล API (พร้อม warnings ของรอบคำนวณ) — ไม่ผูกกับ rowId
      try {
        cache.put(cacheKey, JSON.stringify({
          orderedWaypoints: result.orderedWaypoints,
          totalDistance: result.totalDistance,
          totalMinutes: result.totalMinutes,
          googleMapsLink: result.googleMapsLink,
          cachedWarnings: warnings,
          cachedSkipped: skipped
        }), CACHE_TTL_SECONDS);
      } catch (e) {
        Logger.log(`⚠️ เก็บ cache ไม่สำเร็จ (${e.message}) — ไม่กระทบผลลัพธ์`);
      }
    }

    // ✅ เขียนชีต "ทุกครั้ง" ตาม rowId — นี่คือหัวใจของ FIX-A1
    const resultSheet = requireSheet_(ss, SHEET_RESULT);
    writeResultsPro_(resultSheet, rowId, result, warnings);

    const ret = {
      Status: "Success",
      CalculatedDistanceKm: result.totalDistance,
      TravelTimeMinutes: result.totalMinutes,
      GoogleMapsLink: result.googleMapsLink,
      WaypointsUsed: result.orderedWaypoints.length - 1,
      SkippedInvalid: skipped,
      FromCache: fromCache,
      Warnings: warnings
    };
    Logger.log(`✅ Done | Distance: ${result.totalDistance} km | Points: ${ret.WaypointsUsed} | Skipped: ${skipped} | Cache: ${fromCache}`);
    return ret;

  } catch (error) {
    Logger.log(`❌ Error: ${error.message}\n${error.stack}`);
    throw error;   // ให้ AppSheet Bot เห็น error จริง — ห้ามกลืน
  }
}

/** ล้าง cache ผล API ของ shipment ที่ระบุ (ใช้เมื่อข้อมูลต้นทางเปลี่ยน) */
function clearRouteCache(shipmentId) {
  if (!shipmentId) { Logger.log('ระบุ shipmentId เช่น clearRouteCache("SHP-001")'); return; }
  CacheService.getScriptCache().remove(`routeApi_${String(shipmentId).trim()}`);
  Logger.log(`🗑️ ล้าง cache ของ shipment ${shipmentId} แล้ว — ครั้งหน้าจะยิง API ใหม่`);
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
  if (!sheet) throw new Error(`ไม่พบชีต: "${name}" — ตรวจสอบว่าชื่อชีตตรงเป๊ะ (รวมช่องว่าง)`);
  return sheet;
}

function getHeaderIndexMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) throw new Error(`ชีต "${sheet.getName()}" ไม่มีข้อมูลเลย (getLastColumn() = 0)`);
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const map = {};
  header.forEach((name, idx) => { if (name && map[name] === undefined) map[name] = idx + 1; });
  return { header, map };
}

function findRowByValue_(sheet, colIdx, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const range = sheet.getRange(2, colIdx, lastRow - 1, 1);   // ✅ ไม่ over-read เหมือน V1
  const found = range.createTextFinder(String(value).trim()).matchEntireCell(true).findNext();
  return found ? found.getRow() : null;
}

function formatLatLng_(point, withSpace) {
  const sep = withSpace ? ", " : ",";
  return `${point.original.lat.toFixed(6)}${sep}${point.original.lng.toFixed(6)}`;
}

/**
 * [FIX-A3] แปลงสตริงพิกัด → { ok, lat, lng, outOfThailand, reason }
 * ตรวจ regex เข้มงวดทีละส่วน "ก่อน" parseFloat — ปิดช่อง partial-parse
 * เช่น "14.16-46106,100.62" (ขีดกลางแทนจุด) จะถูก reject ไม่ใช่กลายเป็น lat=14.16
 */
function parseCoordString_(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { ok: false, reason: "พิกัดว่าง" };
  }
  // ตัดอักขระที่ไม่เกี่ยว (ช่องว่าง วงเล็บ ฯลฯ) แต่ "คง" ตัวเลข จุด ลบ คอมมา
  const cleaned = String(raw).trim().replace(/[^\d.,\-]/g, "");
  const parts = cleaned.split(",");
  if (parts.length !== 2) {
    return { ok: false, reason: `รูปแบบไม่ใช่ "lat,lng" (แยกได้ ${parts.length} ส่วน)` };
  }
  const latStr = parts[0].trim();
  const lngStr = parts[1].trim();

  // 🔒 ด่านสำคัญ: ทั้งสองส่วนต้องเป็นตัวเลขล้วนตาม regex — ไม่มีเศษอักขระปน
  if (!COORD_PART_REGEX.test(latStr)) {
    return { ok: false, reason: `lat "${latStr}" ไม่ใช่ตัวเลขพิกัดที่ถูกต้อง` };
  }
  if (!COORD_PART_REGEX.test(lngStr)) {
    return { ok: false, reason: `lng "${lngStr}" ไม่ใช่ตัวเลขพิกัดที่ถูกต้อง` };
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: "แปลงเป็นตัวเลขไม่ได้" };
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ok: false, reason: `อยู่นอกช่วง lat/lng โลกจริง (lat=${lat}, lng=${lng})` };
  }
  if (lat === 0 && lng === 0) {
    return { ok: false, reason: "พิกัด (0,0) ไม่สมเหตุสมผล" };
  }

  const outOfThailand = lat < THAI_LAT.min || lat > THAI_LAT.max ||
                        lng < THAI_LNG.min || lng > THAI_LNG.max;
  return { ok: true, lat, lng, outOfThailand };
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

/**
 * [FIX-A4] อ่านข้อมูลแถวที่ match แบบ "cluster" —
 * จับกลุ่มแถวที่ห่างกันไม่เกิน BLOCK_READ_MAX_GAP แล้วอ่านทีละบล็อก
 * และอ่านเฉพาะช่วงคอลัมน์ที่ใช้จริง (minCol..maxCol) ไม่ใช่ทุกคอลัมน์
 * คืน object: { rowIndex: [ค่าคอลัมน์ตั้งแต่ minCol] }, พร้อม colOffset
 */
function readMatchedRowsClustered_(sheet, rowIdxs, minCol, maxCol) {
  const sorted = rowIdxs.slice().sort((a, b) => a - b);
  const clusters = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - prev > BLOCK_READ_MAX_GAP) {
      clusters.push([start, prev]);
      start = sorted[i];
    }
    prev = sorted[i];
  }
  clusters.push([start, prev]);

  const width = maxCol - minCol + 1;
  const rowMap = {};
  clusters.forEach(([from, to]) => {
    const block = sheet.getRange(from, minCol, to - from + 1, width).getValues();
    sorted.forEach(r => {
      if (r >= from && r <= to) rowMap[r] = block[r - from];
    });
  });
  return { rowMap, colOffset: minCol };
}

// =================================================================
// [ 4 ] DATA PREPARATION — Batch read + cluster guard [FIX-A4]
// =================================================================
function prepareWaypointsPro_(ss, shipmentId) {
  const computedSheet = requireSheet_(ss, SHEET_COMPUTED);
  const { map } = getHeaderIndexMap_(computedSheet);

  const shipmentCol = map[COL_SHIPMENT];
  const latlngCol = map[COL_LATLNG];
  const nameCol = map[COL_NAME];
  const distanceCol = map[COL_DEPOT_DISTANCE];

  if (!shipmentCol || !latlngCol) {
    throw new Error(`Missing required columns in "${SHEET_COMPUTED}": ต้องมี "${COL_SHIPMENT}" และ "${COL_LATLNG}"`);
  }
  if (!distanceCol) {
    Logger.log(`⚠️ ไม่พบคอลัมน์ "${COL_DEPOT_DISTANCE}" → ใช้ระยะเส้นตรง (Haversine) เป็น fallback ในการเรียงลำดับ`);
  }

  const lastRow = computedSheet.getLastRow();
  if (lastRow < 2) return { points: [], warnings: [], skipped: 0 };

  const searchRange = computedSheet.getRange(2, shipmentCol, lastRow - 1, 1);
  const matches = searchRange.createTextFinder(String(shipmentId).trim())
    .matchEntireCell(true).findAll();

  const warnings = [];
  let skipped = 0;
  if (!matches.length) return { points: [], warnings, skipped };

  // [FIX-A4] อ่านเฉพาะคอลัมน์ที่ใช้จริง + จับกลุ่มแถวเป็น cluster
  const usedCols = [latlngCol, nameCol, distanceCol].filter(c => c);
  const minCol = Math.min(...usedCols);
  const maxCol = Math.max(...usedCols);
  const rowIdxs = matches.map(m => m.getRow());
  const { rowMap, colOffset } = readMatchedRowsClustered_(computedSheet, rowIdxs, minCol, maxCol);
  const cell = (row, col) => row[col - colOffset];   // helper แปลงเลขคอลัมน์จริง → index ใน block

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

  rowIdxs.slice().sort((a, b) => a - b).forEach(rowIdx => {
    const row = rowMap[rowIdx];
    const latlngRaw = cell(row, latlngCol);

    // [FIX-A3] ตรวจพิกัดแบบเข้มงวด — ไม่มี partial-parse หลุดรอด
    const coord = parseCoordString_(latlngRaw);
    if (!coord.ok) {
      skipped++;
      warnings.push(`แถว ${rowIdx}: ${coord.reason} (raw="${latlngRaw}") → ข้ามจุดนี้`);
      return;
    }
    if (coord.outOfThailand) {
      warnings.push(`แถว ${rowIdx}: พิกัดอยู่นอกกล่องประเทศไทย (lat=${coord.lat.toFixed(4)}, lng=${coord.lng.toFixed(4)}) — ยังใช้คำนวณต่อ แต่ควรตรวจสอบข้อมูล`);
    }
    const lat = coord.lat, lng = coord.lng;

    // ระยะจากคลัง: ใช้ค่าในชีตถ้า valid, ไม่งั้น fallback Haversine (ไม่ใช่ 0 เงียบๆ แบบ V1)
    let distance = null, distanceSource = "sheet";
    if (distanceCol) {
      const raw = cell(row, distanceCol);
      // ตรวจเข้มงวดเช่นกัน: ตัวเลขจากชีต (number) ใช้ได้เลย,
      // สตริงต้องเป็นตัวเลขล้วน (กัน partial-parse เช่น "123.4abc" → 123.4)
      const isCleanNumber = typeof raw === "number" ||
        /^\d{1,7}(\.\d+)?$/.test(String(raw).trim());
      const parsed = typeof raw === "number" ? raw : parseFloat(String(raw).trim());
      if (isCleanNumber && Number.isFinite(parsed) && parsed >= 0) {
        distance = parsed;
      } else {
        warnings.push(`แถว ${rowIdx}: ค่า "${COL_DEPOT_DISTANCE}" = "${raw}" ใช้ไม่ได้ → ใช้ระยะเส้นตรง (Haversine) แทน`);
      }
    }
    if (distance === null) {
      distance = haversineKm_(DEPOT_COORDS.lat, DEPOT_COORDS.lng, lat, lng);
      distanceSource = "haversine";
    }

    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    const rawName = nameCol ? cell(row, nameCol) : "";
    const name = rawName ? String(rawName).trim() : `Point ${idCounter}`;

    if (seen[key]) {
      warnings.push(`แถว ${rowIdx}: พิกัดซ้ำกับ "${seen[key].name}" (${key}) → รวมเป็นจุดเดียว`);
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
// [ 5 ] SORTING — จุดไกลสุด = ปลายทางสุดท้าย (business rule เดิม)
// =================================================================
function orderPoints_(allPoints) {
  const depot = allPoints[0];
  const destinations = allPoints.slice(1);
  // เรียงไกล→ใกล้; เสมอกันใช้ id (ลำดับพบในชีต) เพื่อผลลัพธ์คงที่ (deterministic)
  destinations.sort((a, b) => (b.distance - a.distance) || (a.id - b.id));
  const finalDestination = destinations[0];
  const intermediates = destinations.slice(1);
  return [depot, ...intermediates, finalDestination];
}

// =================================================================
// [ 6 ] API EXECUTION — Routes API v2, TRAFFIC_UNAWARE (คงเดิม)
// =================================================================
function executeGoogleMapsRoutesAPIOneWay(allPoints) {
  const GOOGLE_MAPS_API_KEY = PropertiesService.getScriptProperties().getProperty("GOOGLE_MAPS_API_KEY");
  if (!GOOGLE_MAPS_API_KEY) throw new Error("Google Maps API Key not set in Script Properties (GOOGLE_MAPS_API_KEY)");

  const origin = allPoints[0];
  const finalDestination = allPoints[allPoints.length - 1];
  const intermediates = allPoints.slice(1, -1);

  if (intermediates.length > API_MAX_INTERMEDIATES) {
    throw new Error(`จุดส่งระหว่างกลาง ${intermediates.length} จุด เกินขีดจำกัด Routes API (${API_MAX_INTERMEDIATES}) — พิจารณาแยกทริป หรือใช้ Route Optimization API (GMPRO)`);
  }
  const shouldOptimize = intermediates.length > 1;

  const payload = {
    origin: origin.forApi,
    destination: finalDestination.forApi,
    intermediates: intermediates.map(p => p.forApi),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",   // ⚠️ ห้ามเปลี่ยน — ผลคงที่เพื่อการตรวจสอบเบิกย้อนหลัง
    optimizeWaypointOrder: shouldOptimize
  };

  const apiUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex"
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

  // ✅ ตรวจ routes[] ว่างก่อนใช้งาน (จุดที่ V1 พลาด — TypeError เงียบ)
  if (!result.routes || result.routes.length === 0) {
    throw new Error(`Routes API ไม่พบเส้นทาง (routes ว่าง) — ตรวจพิกัดปลายทางว่าเข้าถึงได้ทางถนนหรือไม่ | Response: ${rawText.substring(0, 500)}`);
  }

  const route = result.routes[0];
  if (!Number.isFinite(route.distanceMeters)) {
    throw new Error(`Routes API ไม่คืน distanceMeters — ไม่บันทึกค่า 0 มั่วๆ | Response: ${rawText.substring(0, 300)}`);
  }
  const totalDistance = Math.round(route.distanceMeters / 1000 * 100) / 100;
  const totalMinutes = route.duration
    ? Math.round(parseFloat(String(route.duration).replace(/s$/, "")) / 60)
    : null;

  // เรียง waypoint ตามที่ API optimize ให้ — ตรวจ index ครบและอยู่ในขอบเขต
  const orderedWaypoints = [origin];
  let usedOptimized = false;
  if (shouldOptimize && Array.isArray(route.optimizedIntermediateWaypointIndex)) {
    const idx = route.optimizedIntermediateWaypointIndex;
    const valid = idx.length === intermediates.length &&
      idx.every(i => Number.isInteger(i) && i >= 0 && i < intermediates.length) &&
      new Set(idx).size === idx.length;   // กัน index ซ้ำ
    if (valid) {
      idx.forEach(i => orderedWaypoints.push(intermediates[i]));
      usedOptimized = true;
    } else {
      Logger.log(`⚠️ optimizedIntermediateWaypointIndex ผิดปกติ (ได้ ${idx.length}/${intermediates.length}) → ใช้ลำดับเรียงตามระยะเดิม`);
    }
  }
  if (!usedOptimized) orderedWaypoints.push(...intermediates);
  orderedWaypoints.push(finalDestination);

  const linkCoordinates = orderedWaypoints.map(p => formatLatLng_(p, false));
  const googleMapsLink = encodeURI(`https://www.google.com/maps/dir/${linkCoordinates.join("/")}`);

  return { orderedWaypoints, totalDistance, totalMinutes, googleMapsLink };
}

/** Retry เฉพาะ 429/5xx ด้วย exponential backoff; 4xx อื่นๆ fail ทันที */
function fetchWithRetry_(url, options) {
  let waitMs = 2000;
  let lastResp = null;
  for (let attempt = 1; attempt <= API_RETRY_MAX; attempt++) {
    lastResp = UrlFetchApp.fetch(url, options);
    const code = lastResp.getResponseCode();
    if (code === 200) return lastResp;
    if ((code === 429 || code >= 500) && attempt < API_RETRY_MAX) {
      Logger.log(`⚠️ Routes API ${code} — attempt ${attempt}/${API_RETRY_MAX}, รอ ${waitMs}ms แล้วลองใหม่`);
      Utilities.sleep(waitMs);
      waitMs *= 2;
      continue;
    }
    break;   // 4xx อื่น (400/403) retry ไปก็ไม่หาย — ออกทันที
  }
  throw new Error(`Routes API Error ${lastResp.getResponseCode()} (หลังพยายามครบ): ${lastResp.getContentText().substring(0, 500)}`);
}

// =================================================================
// [ 7 ] WRITE RESULTS — contiguity check + per-cell fallback [FIX-A2]
// =================================================================
function writeResultsPro_(resultSheet, rowId, result, warnings) {
  const { map } = getHeaderIndexMap_(resultSheet);

  const idCol = map[RESULT_ID_COLUMN];
  if (!idCol) throw new Error(`ไม่พบคอลัมน์ ID "${RESULT_ID_COLUMN}" ในชีต "${SHEET_RESULT}"`);

  const rowIndexInSheet = findRowByValue_(resultSheet, idCol, rowId);
  if (!rowIndexInSheet) throw new Error(`ไม่พบแถวสำหรับ ID: ${rowId} ในชีต "${SHEET_RESULT}"`);

  const mainCol = map[RESULT_COLUMN_NAME];
  const distCol = map[DISTANCE_COLUMN_NAME];
  const linkCol = map[LINK_COLUMN_NAME];
  const durationCol = map[DURATION_COLUMN_NAME];   // optional
  const statusCol = map[STATUS_COLUMN_NAME];        // optional
  const warnCol = map[WARNING_COLUMN_NAME];         // optional

  // คอลัมน์หลักต้องครบ — ขาดคือ throw ไม่ใช่ข้ามเงียบ (จุดที่ V1 พลาด)
  const missing = [];
  if (!mainCol) missing.push(RESULT_COLUMN_NAME);
  if (!distCol) missing.push(DISTANCE_COLUMN_NAME);
  if (!linkCol) missing.push(LINK_COLUMN_NAME);
  if (missing.length) {
    throw new Error(`ไม่พบคอลัมน์ผลลัพธ์ในชีต "${SHEET_RESULT}": ${missing.join(", ")} — ตรวจชื่อคอลัมน์ให้ตรงกับ CONFIG`);
  }

  const resultString = result.orderedWaypoints.map(p => formatLatLng_(p, true)).join(" | ");
  const localWarnings = warnings.slice();   // ไม่ mutate array ของ caller

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    resultSheet.getRange(rowIndexInSheet, mainCol).setValue(resultString);
    resultSheet.getRange(rowIndexInSheet, distCol).setValue(result.totalDistance);
    resultSheet.getRange(rowIndexInSheet, linkCol).setValue(result.googleMapsLink);
    if (durationCol && result.totalMinutes !== null && result.totalMinutes !== undefined) {
      resultSheet.getRange(rowIndexInSheet, durationCol).setValue(result.totalMinutes);
    }

    // --- เขียนพิกัดแยกรายจุด Lat/Long_ปลายทาง_01..20 ---
    const prefix = RESULT_FIRST_DEST_COLUMN.replace(/01$/, "");
    const destCols = [];
    for (let i = 1; i <= MAX_DEST_COLUMNS; i++) {
      destCols.push(map[`${prefix}${String(i).padStart(2, "0")}`]);
    }

    const customersOnly = result.orderedWaypoints.slice(1);
    if (customersOnly.length > MAX_DEST_COLUMNS) {
      localWarnings.push(`จุดส่ง ${customersOnly.length} จุด เกินคอลัมน์รองรับ ${MAX_DEST_COLUMNS} ช่อง — จุดที่ ${MAX_DEST_COLUMNS + 1} เป็นต้นไปไม่ถูกเขียนแยก (ยังอยู่ครบในสตริงหลัก)`);
    }
    const valuesToWrite = new Array(MAX_DEST_COLUMNS).fill("");
    customersOnly.slice(0, MAX_DEST_COLUMNS).forEach((p, i) => {
      valuesToWrite[i] = formatLatLng_(p, true);
    });

    const allPresent = destCols.every(c => c !== undefined);
    // [FIX-A2] ตรวจ "ติดกัน" ไม่ใช่แค่ "มีครบ" — กันเขียนทับคอลัมน์ที่ถูกแทรกกลาง
    const contiguous = allPresent && destCols.every((c, i) => c === destCols[0] + i);

    if (contiguous) {
      // เร็วสุด: เขียนครั้งเดียว 20 ช่อง
      resultSheet.getRange(rowIndexInSheet, destCols[0], 1, MAX_DEST_COLUMNS).setValues([valuesToWrite]);
    } else if (allPresent) {
      // ปลอดภัยเสมอ: คอลัมน์ไม่ติดกัน (มีคอลัมน์แทรก) → เขียนทีละเซลล์ตามตำแหน่งจริง
      localWarnings.push(`คอลัมน์ Lat/Long_ปลายทาง_01..${MAX_DEST_COLUMNS} มีครบแต่ "ไม่ติดกัน" (มีคอลัมน์อื่นแทรก) → เขียนทีละเซลล์แทน batch เพื่อไม่ทับคอลัมน์แทรก`);
      Logger.log(`⚠️ ${localWarnings[localWarnings.length - 1]}`);
      destCols.forEach((c, i) => {
        resultSheet.getRange(rowIndexInSheet, c).setValue(valuesToWrite[i]);
      });
    } else {
      const found = destCols.filter(c => c !== undefined).length;
      localWarnings.push(`คอลัมน์ Lat/Long_ปลายทาง_01..${MAX_DEST_COLUMNS} ไม่ครบ (เจอ ${found}/${MAX_DEST_COLUMNS}) → เขียนเฉพาะคอลัมน์ที่มีจริง`);
      Logger.log(`⚠️ ${localWarnings[localWarnings.length - 1]}`);
      destCols.forEach((c, i) => {
        if (c !== undefined) resultSheet.getRange(rowIndexInSheet, c).setValue(valuesToWrite[i]);
      });
    }

    if (statusCol) resultSheet.getRange(rowIndexInSheet, statusCol).setValue("OK");
    if (warnCol) resultSheet.getRange(rowIndexInSheet, warnCol).setValue(
      localWarnings.length ? localWarnings.join(" | ") : ""
    );
  } finally {
    lock.releaseLock();
  }

  Logger.log(`✅ Updated Row ${rowIndexInSheet} | Distance: ${result.totalDistance} km | ${resultString.substring(0, 60)}...`);
}

// =================================================================
// [ 8 ] (BONUS) BATCH RUNNER — รันคิวหลายรายการ กันชนลิมิต 6 นาที
// =================================================================
function runRoutingQueue_(queueSheetName) {
  const ss = openTargetSpreadsheet_();
  const queue = requireSheet_(ss, queueSheetName || "RoutingQueue");
  const { map } = getHeaderIndexMap_(queue);
  const shipCol = map["ShipmentId"], rowCol = map["RowId"], doneCol = map["Done"];
  if (!shipCol || !rowCol || !doneCol) throw new Error("RoutingQueue ต้องมีคอลัมน์: ShipmentId | RowId | Done");

  const lastRow = queue.getLastRow();
  if (lastRow < 2) { Logger.log("คิวว่าง"); return; }
  const values = queue.getRange(2, 1, lastRow - 1, Math.max(shipCol, rowCol, doneCol)).getValues();

  const startedAt = Date.now();
  const TIME_BUDGET_MS = 4.5 * 60 * 1000;   // เผื่อ margin จากลิมิต 6 นาที
  let done = 0;
  for (let i = 0; i < values.length; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      Logger.log(`⏱️ ใกล้ครบลิมิตเวลา — ทำไปแล้ว ${done} รายการ, รอบถัดไปทำต่อ`);
      return;
    }
    const r = i + 2;
    if (values[i][doneCol - 1]) continue;
    try {
      findOptimalRouteUsingExistingDistance(values[i][shipCol - 1], values[i][rowCol - 1]);
      queue.getRange(r, doneCol).setValue("DONE");
    } catch (e) {
      queue.getRange(r, doneCol).setValue(`ERROR: ${String(e.message).substring(0, 180)}`);
      Logger.log(`❌ แถว ${r} พัง — ข้ามไปทำรายการถัดไป: ${e.message}`);
    }
    Utilities.sleep(300);   // เว้นจังหวะกัน rate limit
    done++;
  }
  Logger.log(`✅ คิวเสร็จทั้งหมด (${done} รายการในรอบนี้)`);
}
