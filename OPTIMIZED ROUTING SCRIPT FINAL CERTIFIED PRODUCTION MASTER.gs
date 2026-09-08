/**- =========================================================================
  - OPTIMIZED ROUTING SCRIPT (FINAL CERTIFIED PRODUCTION MASTER)
  - =========================================================================
  - ระบบคำนวณเส้นทางขนส่งและทำเบิกส่วนต่าง SCG/JWD วังน้อย (AppSheet Integrated)
  - 
  - ✔ Business Rule Compliance: ยึดจุดไกลสุดจากคลังเป็น Anchor
    ปลายทางตามสัญญาจ้าง 100%
  - ✔ Zero Silent Loss: พิกัดเสีย หรือ จุดส่งเกิน 20 จุด แจ้งเตือนเลขแถวทันที
  - ✔ AppSheet Compatible: เก็บสตริงพิกัดดิบเดิม (rawLatLong) สูตร LOOKUP
    รูปภาพไม่พัง
  - ✔ Bounding-Box Batch Read: อ่านข้อมูลครั้งเดียว ปราศจาก N+1 และปลอดภัยต่อ
    RAM
  - ✔ Parallel Engine with Dynamic Fallback: ยิงขนาน 3 Candidates
    พร้อมระบบสำรองที่แท้จริง
  - ✔ Exponential Backoff Retry: กู้คืนคำขออัตโนมัติเมื่อเจอ HTTP 429 หรือ 5xx
  - ✔ Waypoint Permutation Guard: ตรวจสอบความถูกต้องของลำดับจุดแวะจาก Google API
  - ✔ Safe Concurrency: ป้องกันการแย่งสิทธิ์ด้วย LockService 60 วินาที
  - ========================================================================= */

const CONFIG = Object.freeze({ SPREADSHEET_ID:
"1CYtLpXn6gNYgbGu3oRF8CW5KkGYHQJ6D4jl9u2LiR6o", SHEET_COMPUTED:
"SCGนครหลวงJWDภูมิภาค", SHEET_RESULT: "ทำเบิกส่วนต่างScgวังน้อย",

// พิกัดคลังวังน้อย ตรงตาม Col #7 (ต้นทาง) ใน AppSheet Schema DEPOT_COORDS:
Object.freeze({ lat: 14.164671, lng: 100.625358, name: "คลังสินค้า เอสซีจี
เจดับเบิ้ลยูดี วังน้อย" }),

COLUMNS: Object.freeze({ // ตารางต้นทาง (SCGนครหลวงJWDภูมิภาค) SOURCE_SHIPMENT:
"Shipment No", SOURCE_DEST_LATLONG: "จุดส่งสินค้าปลายทาง", SOURCE_DEST_NAME:
"ชื่อปลายทาง", SOURCE_DEPOT_DIST: "ระยะทางจากคลัง_Km",

// ตารางปลายทาง (ทำเบิกส่วนต่างScgวังน้อย)
ID_RESULT_NAME: "ID_ทำเบิกส่วนต่างScgวังน้อย",
RESULT_NAME: "GoogleMapsRoutesAPI",
DISTANCE_NAME: "ระยะทาง_GoogleMapAPI_Km",
LINK_NAME: "แสดงแผนที่_GoogleMapsRoutesAPI",

// 4 คอลัมน์ต่อท้ายชีต สำหรับบันทึก Candidate สำรอง (Audit Trail)
CANDIDATE_2_DIST: "Candidate_2_ระยะทาง_Km",
CANDIDATE_2_LINK: "Candidate_2_แสดงแผนที่",
CANDIDATE_3_DIST: "Candidate_3_ระยะทาง_Km",
CANDIDATE_3_LINK: "Candidate_3_แสดงแผนที่"

}),

CANDIDATE_COUNT: 3, LOCK_TIMEOUT_MS: 60000, // 60 วินาที รองรับสถานะ Worst-Case
Sequential Retry MAX_WAYPOINTS_DETAIL_COLS: 20 });

// ================================================================= // [ 1 ]
MAIN ENTRY POINT (Orchestrator) //
================================================================= function
findOptimalRouteUsingExistingDistance(shipmentId, rowId) { const startTime = new
Date().getTime();
Logger.log(=================================================================);
Logger.log(🚀 [START] Route Engine | Shipment: ${shipmentId} | Row ID: ${rowId});
Logger.log(=================================================================);

if (!shipmentId || !rowId) { throw new Error("[Invalid Input] ต้องระบุ
shipmentId และ rowId ให้ครบถ้วน"); }

// Fail-Fast: ตรวจสอบ API Key ก่อนเริ่มกระบวนการ const apiKey =
PropertiesService.getScriptProperties().getProperty("GOOGLE_MAPS_API_KEY"); if
(!apiKey || apiKey.trim().length < 20) { throw new Error("[Security Error] ไม่พบ
GOOGLE_MAPS_API_KEY ที่ถูกต้องใน Script Properties"); }

const lock = LockService.getScriptLock(); let hasLock = false;

try { hasLock = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS); if (!hasLock) { throw new
Error([Concurrency Error] เซิร์ฟเวอร์กำลังประมวลผลคำขออื่นอยู่ (รอนานเกิน
${CONFIG.LOCK_TIMEOUT_MS / 1000} วินาที) กรุณากดใหม่อีกครั้ง); }

const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

// 1. ดึงจุดส่งทั้งหมดด้วย Bounding-Box Batch Read (1 I/O Call เท่านั้น)
const waypoints = prepareWaypointsWithExistingDistance(ss, shipmentId);
if (waypoints.length <= 1) {
  throw new Error(`[Data Error] ไม่พบจุดส่งสินค้าปลายทางที่สมบูรณ์สำหรับ Shipment: ${shipmentId}`);
}

const destinationCount = waypoints.length - 1;
Logger.log(`📍 โหลดข้อมูลสำเร็จ: พบจุดส่งทั้งหมด ${destinationCount} จุด`);

// ป้องกันจุดส่งเกิน 20 จุด ซึ่งเกินขีดจำกัดตาราง AppSheet
if (destinationCount > CONFIG.MAX_WAYPOINTS_DETAIL_COLS) {
  throw new Error(`[Limit Error] Shipment นี้มีจุดส่ง ${destinationCount} จุด ซึ่งเกินขีดจำกัดตาราง (${CONFIG.MAX_WAYPOINTS_DETAIL_COLS} ช่อง) กรุณาตรวจสอบ`);
}

let evaluationResult;

// 2. Fast-Path Optimization กรณีมีจุดส่งเพียง 1 จุด
if (destinationCount === 1) {
  Logger.log(`⚡ [Fast-Path] มีจุดส่งเพียง 1 จุด ข้าม Candidate Engine ยิงคำขอตรงทันที`);
  evaluationResult = executeSingleRoute(waypoints, apiKey);
} else {
  // 3. Multi-Candidate Parallel Engine (ยึดจุดไกลสุดตามระเบียบ One-Way Milk Run)
  const candidateTrials = buildCandidateTrials(waypoints, CONFIG.CANDIDATE_COUNT);
  Logger.log(`🔍 สร้าง ${candidateTrials.length} Candidates เพื่อประมวลผลเปรียบเทียบหาเส้นทางที่ดีที่สุด`);
  evaluationResult = evaluateCandidateRoutesParallelWithFallback(candidateTrials, apiKey);
}

const winner = evaluationResult.winner;
const runnerUps = evaluationResult.runnerUps || [];
const warnings = evaluationResult.warnings || [];

Logger.log(`🏆 [ผู้ชนะ] ปลายทาง: ${winner.candidateName} | ระยะทางรวม: ${winner.totalDistance} กม.`);
if (runnerUps.length > 0) {
  runnerUps.forEach((r, idx) => {
    Logger.log(`   🥈 [สำรองอันดับ ${idx + 1}] ปลายทาง: ${r.candidateName} | ระยะทาง: ${r.totalDistance} กม.`);
  });
}

// 4. บันทึกผลลัพธ์ลงชีตแบบ Single-Batch Write
const resultSheet = ss.getSheetByName(CONFIG.SHEET_RESULT);
if (!resultSheet) throw new Error(`[Sheet Error] ไม่พบแผ่นงาน '${CONFIG.SHEET_RESULT}'`);

writeResultsToSheetBatchSafely(resultSheet, rowId, winner, runnerUps);

const totalTimeSec = ((new Date().getTime() - startTime) / 1000).toFixed(2);
Logger.log(`✅ [SUCCESS] ประมวลผลเสร็จสิ้นใน ${totalTimeSec} วินาที`);

return {
  Status: "Success",
  ShipmentId: shipmentId,
  CalculatedDistanceKm: winner.totalDistance,
  GoogleMapsLink: winner.googleMapsLink,
  SelectedDestination: winner.candidateName,
  ExecutionTimeSeconds: totalTimeSec,
  Warnings: warnings.length > 0 ? warnings : undefined
};

} catch (error) { Logger.log(❌ [CRITICAL ERROR] ${error.message}\nStack:
${error.stack}); throw new Error(error.message); // ตัด stack trace ภายใน
ป้องกัน Error หน้าบ้านพัง } finally { if (hasLock) { lock.releaseLock(); } } }

// ================================================================= // [ 2 ]
DATA PREPARATION (Bounding-Box Single Batch Read) //
================================================================= function
prepareWaypointsWithExistingDistance(ss, shipmentId) { const computedSheet =
ss.getSheetByName(CONFIG.SHEET_COMPUTED); if (!computedSheet) throw new
Error([Sheet Error] ไม่พบแผ่นงาน '${CONFIG.SHEET_COMPUTED}');

const lastRow = computedSheet.getLastRow(); const lastCol =
computedSheet.getLastColumn(); if (lastRow < 2) return [];

const header = computedSheet.getRange(1, 1, 1, lastCol).getValues()[0]; const
shipmentColIdx = header.indexOf(CONFIG.COLUMNS.SOURCE_SHIPMENT); const
latlngColIdx = header.indexOf(CONFIG.COLUMNS.SOURCE_DEST_LATLONG); const
nameColIdx = header.indexOf(CONFIG.COLUMNS.SOURCE_DEST_NAME); const
distanceColIdx = header.indexOf(CONFIG.COLUMNS.SOURCE_DEPOT_DIST);

if (shipmentColIdx === -1 || latlngColIdx === -1) { throw new Error("[Schema
Error] ไม่พบคอลัมน์ 'Shipment No' หรือ 'จุดส่งสินค้าปลายทาง' ในชีตต้นทาง"); }

const numRowsToSearch = lastRow - 1; const searchRange =
computedSheet.getRange(2, shipmentColIdx + 1, numRowsToSearch, 1); const matches
=
searchRange.createTextFinder(String(shipmentId).trim()).matchEntireCell(true).findAll();

if (matches.length === 0) return [];

// เทคนิค Bounding-Box Batch Read: หา minRow และ maxRow
แล้วอ่านก้อนข้อมูลรอบเดียว const matchedRowIndices = matches.map(m =>
m.getRow()); const minRow = Math.min(...matchedRowIndices); const maxRow =
Math.max(...matchedRowIndices); const rowSpan = maxRow - minRow + 1;

const chunkData = computedSheet.getRange(minRow, 1, rowSpan,
lastCol).getValues();

const allPoints = [{ id: 0, name: CONFIG.DEPOT_COORDS.name, rawLatLong:
${CONFIG.DEPOT_COORDS.lat}, ${CONFIG.DEPOT_COORDS.lng}, original: { lat:
CONFIG.DEPOT_COORDS.lat, lng: CONFIG.DEPOT_COORDS.lng }, forApi: { location: {
latLng: { latitude: CONFIG.DEPOT_COORDS.lat, longitude: CONFIG.DEPOT_COORDS.lng
} } }, distance: 0, isDepot: true }];

let idCounter = 1; const invalidRows = [];

matchedRowIndices.forEach(rowIdx => { // ดึงค่าจาก RAM Chunk โดยตรง ไม่เกิด N+1
I/O const rowValues = chunkData[rowIdx - minRow]; const latlngRaw =
rowValues[latlngColIdx];

if (!latlngRaw) {
  invalidRows.push({ row: rowIdx, reason: "พิกัดว่างเปล่า" });
  return;
}

const rawString = String(latlngRaw).trim();
const parsed = parseAndValidateLatLng(rawString);
if (!parsed) {
  invalidRows.push({ row: rowIdx, value: rawString, reason: "รูปแบบพิกัดไม่ถูกต้อง หรืออยู่นอกเขตพิกัดจริง" });
  return;
}

let distance = (distanceColIdx !== -1) ? (parseFloat(rowValues[distanceColIdx]) || 0) : 0;
// Fallback ด้วย Haversine ทันทีหากระยะทางเดิมเป็น 0 เพื่อป้องกันจุดไกลสุดสลับตำแหน่ง
if (distance <= 0) {
  distance = calculateHaversineDistanceKm(CONFIG.DEPOT_COORDS.lat, CONFIG.DEPOT_COORDS.lng, parsed.lat, parsed.lng);
}

let name = `Point ${idCounter}`;
if (nameColIdx !== -1 && rowValues[nameColIdx]) {
  name = String(rowValues[nameColIdx]).trim();
}

allPoints.push({
  id: idCounter++,
  name: name,
  rawLatLong: rawString, // คงสตริงดิบเดิมไว้ 100% เพื่อสูตร LOOKUP ใน AppSheet
  original: parsed,
  forApi: { location: { latLng: { latitude: parsed.lat, longitude: parsed.lng } } },
  distance: distance,
  isDepot: false
});

});

// Zero Silent Loss Guard: หากมีข้อมูลเสียแม้แต่จุดเดียว ให้แจ้งเตือนทันที if
(invalidRows.length > 0) { const details = invalidRows.map(r => [แถว ${r.row}:
${r.reason} (${r.value || 'ว่าง'})]).join(", "); throw new Error([Data Integrity
Error] Shipment ${shipmentId} พบจุดส่งข้อมูลเสียหาย ${invalidRows.length} จุด:
${details}); }

return allPoints; }

function parseAndValidateLatLng(rawString) { if (!rawString) return null; const
cleaned = rawString.trim().replace(/[\t\r\n]/g, "").replace(/[^\d.,-]/g, "");
const parts = cleaned.split(","); if (parts.length !== 2) return null;

const lat = parseFloat(parts[0].trim()); const lng =
parseFloat(parts[1].trim());

if (isNaN(lat) || isNaN(lng)) return null; if (lat < -90 || lat > 90 || lng <
-180 || lng > 180) return null;

return { lat, lng }; }

function calculateHaversineDistanceKm(lat1, lon1, lat2, lon2) { const R = 6371;
const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI
/ 180; const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 *
Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) *
Math.sin(dLon / 2); const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
return Math.round(R * c * 100) / 100; }

// คัดเลือก Candidate ปลายทางจากจุดที่ไกลจากคลังวังน้อยที่สุด ตามระเบียบ One-Way
Milk Run function buildCandidateTrials(allPoints, maxCandidates = 3) { const
depot = allPoints[0]; const destinations = allPoints.slice(1);

const sortedByDepotDistance = [...destinations].sort((a, b) => b.distance -
a.distance); const candidateDestinations = sortedByDepotDistance.slice(0,
Math.min(maxCandidates, sortedByDepotDistance.length));

return candidateDestinations.map(candidate => { const intermediates =
destinations.filter(p => p.id !== candidate.id); return { origin: depot,
destination: candidate, intermediates: intermediates }; }); }

// ================================================================= // [ 3 ]
API EXECUTION (Parallel Engine + Dynamic Index Fallback) //
=================================================================

// Fast-Path สำหรับกรณีมีจุดส่ง 1 จุด function executeSingleRoute(waypoints,
apiKey) { const origin = waypoints[0]; const destination = waypoints[1]; const
payload = { origin: origin.forApi, destination: destination.forApi, travelMode:
'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' };

const responseJson = callRoutesApiSingleWithBackoff(payload, apiKey); if
(!responseJson || !responseJson.routes || responseJson.routes.length === 0) {
throw new Error("[API Error] Google Maps API
ไม่พบเส้นทางเชื่อมต่อระหว่างคลังกับจุดส่งนี้"); }

const distanceMeters = responseJson.routes[0].distanceMeters; if (typeof
distanceMeters !== 'number' || isNaN(distanceMeters)) { throw new Error("[API
Error] ข้อมูลระยะทางจาก Google API ไม่ถูกต้อง"); }

const totalDistance = Math.round((distanceMeters / 1000) * 100) / 100; const
googleMapsLink = createGoogleMapsUrl([origin, destination]);

return { winner: { orderedWaypoints: [origin, destination], totalDistance,
googleMapsLink, winningCandidateId: destination.id, candidateName:
destination.name }, runnerUps: [], warnings: [] }; }

// Multi-Candidate Parallel Engine พร้อม Dynamic Fallback & Retry function
evaluateCandidateRoutesParallelWithFallback(candidateTrials, apiKey) { const
apiUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";

const fetchRequests = candidateTrials.map(trial => { const shouldOptimize =
trial.intermediates.length > 1; const payload = { origin: trial.origin.forApi,
destination: trial.destination.forApi, travelMode: 'DRIVE', routingPreference:
'TRAFFIC_UNAWARE', optimizeWaypointOrder: shouldOptimize };

if (trial.intermediates.length > 0) {
  payload.intermediates = trial.intermediates.map(p => p.forApi);
}

return {
  url: apiUrl,
  method: 'post',
  contentType: 'application/json',
  headers: {
    'X-Goog-Api-Key': apiKey,
    'X-Goog-FieldMask': 'routes.distanceMeters,routes.optimizedIntermediateWaypointIndex'
  },
  payload: JSON.stringify(payload),
  muteHttpExceptions: true
};

});

let rawResponses = null; try { // ยิงแบบขนานพร้อมกัน 3 คำขอ rawResponses =
UrlFetchApp.fetchAll(fetchRequests); } catch (netErr) { Logger.log(⚠️ [Network
Error in fetchAll] ${netErr.message} -> สลับสู่โหมด Sequential Fallback); }

const validResults = []; const failedTrials = [];

candidateTrials.forEach((trial, index) => { let resultJson = null;

// ตรวจสอบผลลัพธ์จาก fetchAll
if (rawResponses && rawResponses[index]) {
  const resp = rawResponses[index];
  if (resp.getResponseCode() === 200) {
    try {
      resultJson = JSON.parse(resp.getContentText());
    } catch (e) {
      resultJson = null;
    }
  }
}

// Dynamic Fallback: ดึง payload ของ Index นั้นๆ จริง (ไม่ Hardcode [0]) พร้อม Retry
if (!resultJson || !resultJson.routes || resultJson.routes.length === 0) {
  try {
    const payload = JSON.parse(fetchRequests[index].payload);
    resultJson = callRoutesApiSingleWithBackoff(payload, apiKey);
  } catch (err) {
    failedTrials.push(`${trial.destination.name} (${err.message})`);
    return;
  }
}

if (!resultJson || !resultJson.routes || resultJson.routes.length === 0) {
  failedTrials.push(`${trial.destination.name} (No Route Found)`);
  return;
}

const route = resultJson.routes[0];
const distanceMeters = route.distanceMeters;
if (typeof distanceMeters !== 'number' || isNaN(distanceMeters)) {
  failedTrials.push(`${trial.destination.name} (Invalid Distance)`);
  return;
}

const totalDistance = Math.round((distanceMeters / 1000) * 100) / 100;

// Permutation Guard: ตรวจสอบความถูกต้องของ Index จาก Google API
const orderedWaypoints = [trial.origin];
const intermediates = trial.intermediates;

if (intermediates.length > 1 && Array.isArray(route.optimizedIntermediateWaypointIndex)) {
  const indices = route.optimizedIntermediateWaypointIndex;
  if (isValidPermutation(indices, intermediates.length)) {
    indices.forEach(idx => orderedWaypoints.push(intermediates[idx]));
  } else {
    Logger.log(`⚠️ Waypoint index ผิดปกติสำหรับ Candidate: ${trial.destination.name} -> กลับไปใช้ลำดับเดิม`);
    orderedWaypoints.push(...intermediates);
  }
} else {
  orderedWaypoints.push(...intermediates);
}
orderedWaypoints.push(trial.destination);

const googleMapsLink = createGoogleMapsUrl(orderedWaypoints);

validResults.push({
  orderedWaypoints,
  totalDistance,
  googleMapsLink,
  winningCandidateId: trial.destination.id,
  candidateName: trial.destination.name
});

});

if (validResults.length === 0) { throw new Error("[API Error] การทดสอบ Candidate
ทุกเส้นทางล้มเหลว ไม่สามารถคำนวณเส้นทางได้"); }

// เรียงลำดับจากระยะทางรวมน้อยสุดไปหามากสุด (ระยะทางสั้นที่สุดคือผู้ชนะ)
validResults.sort((a, b) => a.totalDistance - b.totalDistance);

const warnings = []; if (failedTrials.length > 0) { warnings.push(มี
${failedTrials.length} Candidates ที่คำนวณไม่สำเร็จ: ${failedTrials.join(',
')}); Logger.log(⚠️ Warning: ${warnings[0]}); }

return { winner: validResults[0], runnerUps: validResults.slice(1), warnings:
warnings }; }

// ตรวจสอบความสมบูรณ์ของ Permutation Index function isValidPermutation(indices,
expectedLength) { if (!Array.isArray(indices) || indices.length !==
expectedLength) return false; const seen = new Set(); for (let i = 0; i <
indices.length; i++) { const val = indices[i]; if (typeof val !== 'number' ||
val < 0 || val >= expectedLength || seen.has(val)) { return false; }
seen.add(val); } return true; }

// Single Call พร้อม Exponential Backoff หน่วงเวลาอัตโนมัติ (รองรับ 429, 5xx)
function callRoutesApiSingleWithBackoff(payload, apiKey, maxRetries = 3) { const
apiUrl = "https://routes.googleapis.com/directions/v2:computeRoutes"; const
options = { method: 'post', contentType: 'application/json', headers: {
'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask':
'routes.distanceMeters,routes.optimizedIntermediateWaypointIndex' }, payload:
JSON.stringify(payload), muteHttpExceptions: true };

for (let attempt = 1; attempt <= maxRetries; attempt++) { const response =
UrlFetchApp.fetch(apiUrl, options); const code = response.getResponseCode();

if (code === 200) {
  return JSON.parse(response.getContentText());
}

// หากเป็น 400 หรือ 403 ให้หยุดทันที ไม่ต้อง Retry
if (code !== 429 && code < 500) {
  throw new Error(`API Rejected [HTTP ${code}]: ${response.getContentText()}`);
}

// กรณี Rate Limit (429) หรือ Server Error (5xx) ให้เข้าสู่ Exponential Backoff
if (attempt < maxRetries) {
  const delayMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500); // 2s, 4s + Jitter
  Logger.log(`⚠️ [Backoff Retry] ติดขัด HTTP ${code} -> รอ ${delayMs}ms ก่อนลองใหม่ (ครั้งที่ ${attempt}/${maxRetries})`);
  Utilities.sleep(delayMs);
} else {
  throw new Error(`API Failed after ${maxRetries} attempts [HTTP ${code}]`);
}

} }

function createGoogleMapsUrl(orderedWaypoints) { const linkCoordinates =
orderedWaypoints.map(p =>
${p.original.lat.toFixed(6)},${p.original.lng.toFixed(6)}); return
https://www.google.com/maps/dir/${linkCoordinates.join('/')}; }

// ================================================================= // [ 4 ]
WRITE RESULTS (Safe Single-Batch Write & Array Dimension Lock) //
================================================================= function
writeResultsToSheetBatchSafely(resultSheet, rowId, winner, runnerUps) { const
lastCol = resultSheet.getLastColumn(); const lastRow = resultSheet.getLastRow();
if (lastRow < 2) throw new Error("[Data Error] แผ่นงานผลลัพธ์ไม่มีแถวข้อมูล");

const header = resultSheet.getRange(1, 1, 1, lastCol).getValues()[0];

const idIndex = header.indexOf(CONFIG.COLUMNS.ID_RESULT_NAME); const
mainResultColIndex = header.indexOf(CONFIG.COLUMNS.RESULT_NAME); const
distanceColIndex = header.indexOf(CONFIG.COLUMNS.DISTANCE_NAME); const
linkColIndex = header.indexOf(CONFIG.COLUMNS.LINK_NAME);

// คอลัมน์สำหรับเก็บเส้นทางสำรอง (Audit Trail) const c2DistIdx =
header.indexOf(CONFIG.COLUMNS.CANDIDATE_2_DIST); const c2LinkIdx =
header.indexOf(CONFIG.COLUMNS.CANDIDATE_2_LINK); const c3DistIdx =
header.indexOf(CONFIG.COLUMNS.CANDIDATE_3_DIST); const c3LinkIdx =
header.indexOf(CONFIG.COLUMNS.CANDIDATE_3_LINK);

if (idIndex === -1) throw new Error([Schema Error] ไม่พบคอลัมน์
'${CONFIG.COLUMNS.ID_RESULT_NAME}' ในแผ่นงานผลลัพธ์);

const idRange = resultSheet.getRange(2, idIndex + 1, lastRow - 1, 1); const
idMatch =
idRange.createTextFinder(String(rowId).trim()).matchEntireCell(true).findNext();
if (!idMatch) throw new Error([Data Error] ไม่พบแถวที่มี ID: ${rowId});

const rowIndexInSheet = idMatch.getRow(); const rowValues =
resultSheet.getRange(rowIndexInSheet, 1, 1, lastCol).getValues()[0];

// 1. บันทึกผลลัพธ์ผู้ชนะ (อันดับ 1) const resultString =
winner.orderedWaypoints.map(p => ${p.original.lat.toFixed(6)},
${p.original.lng.toFixed(6)}).join(" | "); if (mainResultColIndex !== -1)
rowValues[mainResultColIndex] = resultString; if (distanceColIndex !== -1)
rowValues[distanceColIndex] = winner.totalDistance; if (linkColIndex !== -1)
rowValues[linkColIndex] = winner.googleMapsLink;

// 2. บันทึกจุดส่งย่อย 01 - 20 (ใช้ rawLatLong สตริงเดิม เพื่อสูตร LOOKUP ใน
AppSheet) const customersOnly = winner.orderedWaypoints.slice(1); for (let i
= 1; i <= CONFIG.MAX_WAYPOINTS_DETAIL_COLS; i++) { const colName =
Lat/Long_ปลายทาง_${String(i).padStart(2, '0')}; const colIdx =
header.indexOf(colName);

if (colIdx !== -1) {
  const point = customersOnly[i - 1];
  rowValues[colIdx] = point ? point.rawLatLong : "";
}

}

// 3. บันทึกผลลัพธ์ Candidate สำรอง (อันดับ 2 และ 3) หากมีคอลัมน์ในชีต if
(runnerUps[0]) { if (c2DistIdx !== -1) rowValues[c2DistIdx] =
runnerUps[0].totalDistance; if (c2LinkIdx !== -1) rowValues[c2LinkIdx] =
runnerUps[0].googleMapsLink; } if (runnerUps[1]) { if (c3DistIdx !== -1)
rowValues[c3DistIdx] = runnerUps[1].totalDistance; if (c3LinkIdx !== -1)
rowValues[c3LinkIdx] = runnerUps[1].googleMapsLink; }

// ล็อกขนาด Range ด้วย rowValues.length เสมอ เพื่อป้องกันปัญหาขนาด Array
ไม่ตรงกับ Range resultSheet.getRange(rowIndexInSheet, 1, 1,
rowValues.length).setValues([rowValues]);

Logger.log(💾 [Batch Write Success] บันทึกผลลงแถวที่ ${rowIndexInSheet}
เรียบร้อยแล้ว); }
