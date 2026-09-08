/**
 * ============================================================================
 * "PRO CANDIDATE ENGINE VERSION" — [ARCHIVED FOR AUDIT — ❌ ไม่ผ่านการตรวจรับ]
 * ============================================================================
 * โค้ดฉบับนี้ส่งเข้ามาในแชท (AI ท่านอื่น) — เก็บไว้เพื่อการตรวจสอบเท่านั้น ห้ามใช้งานจริง
 * ผลตรวจรับโดยละเอียด: audit/AUDIT_REPORT_CANDIDATE_ENGINE.md
 *
 * สรุปข้อบกพร่อง (ยืนยันทุกข้อด้วยการรันโค้ดจริงใน Node.js):
 *  [C1] 🔴 เปลี่ยน BUSINESS RULE โดยพลการ: จาก "จุดไกลสุด = ปลายทาง" เป็น
 *       "เลือกเส้นทางรวมสั้นสุดจาก Top-3" — กระทบยอดเบิกโดยตรง ต้องมีการอนุมัติก่อน
 *  [C2] 🔴 (distanceMeters || 0)/1000 → candidate ที่ API ไม่คืนระยะได้ 0 km
 *       → "ชนะ" การเปรียบเทียบ minimum เสมอ = ระยะเบิก 0 กม. แบบเงียบ
 *  [C3] 🔴 ต้นทุน API x3 ทุกครั้ง (fetchAll 3 requests, optimize ทุกตัว = Advanced SKU x3)
 *  [C4] 🔴 ไม่มี retry + candidate fail ถูก "ข้ามเงียบ" → 429 ชั่วคราวทำให้
 *       "ผู้ชนะเปลี่ยน" ระหว่างรัน = ผลไม่คงที่ (non-deterministic) ขัดหลัก audit เบิกเงิน
 *  [C5] 🟠 REGRESSION: กลับไปอ่านชีตแบบ N+1 (getRange ทีละแถวในลูป) — ถอยหลังกว่า V2/V3
 *  [C6] 🟠 REGRESSION: parseFloat(...) || 0 กลืน NaN → จุดไกลจริงที่ค่าระยะเสีย
 *       หลุดจาก Top-3 แบบเงียบ + partial-parse "14.16-46106"→14.16 กลับมา (A3 เดิม)
 *  [C7] 🔴 REGRESSION: เขียน 20 คอลัมน์แบบ positional (firstDestColIndex + i)
 *       ไม่ตรวจ presence/contiguity เลย → คอลัมน์แทรกถูกทับแน่นอน (แย่กว่า V2)
 *  [C8] 🟠 เขียนทั้งแถว read-modify-write (getValues ทั้งแถว → setValues ทั้งแถว)
 *       → ทับค่าคอลัมน์อื่นที่ AppSheet sync แก้ระหว่างช่วง read→write
 *       (LockService ล็อกเฉพาะสคริปต์ ไม่ล็อก AppSheet)
 *  [C9] 🟠 optimizedIntermediateWaypointIndex ตรวจแค่ existence → index ไม่ครบ
 *       = จุดหายจากสตริง/ลิงก์เงียบๆ ขณะระยะทางรวมครบ (ข้อมูลขัดแย้งกันเอง)
 *  [C10] 🟡 ไม่ตรวจลิมิต 25 intermediates / ไม่มี cache / ล็อกครอบทั้ง flow รวม API call
 *        (ล็อกค้าง 30-60 วิ ต่อ 1 งาน — งานอื่นต่อคิวหรือ timeout)
 * ============================================================================
 */

// =================================================================
// [ 1 ] CONFIGURATION & CONSTANTS
// =================================================================
const CONFIG = Object.freeze({
  SPREADSHEET_ID: "1CYtLpXn6gNYgbGu3oRF8CW5KkGYHQJ6D4jl9u2LiR6o",
  SHEET_COMPUTED: "SCGนครหลวงJWDภูมิภาค",
  SHEET_RESULT: "ทำเบิกส่วนต่างScgวังน้อย",

  DEPOT_COORDS: Object.freeze({
    lat: 14.1646106,
    lng: 100.6254644,
    name: "คลังสินค้า เอสซีจี เจดับเบิ้ลยูดี วังน้อย"
  }),

  COLUMNS: Object.freeze({
    RESULT_NAME: "GoogleMapsRoutesAPI",
    DISTANCE_NAME: "ระยะทาง_GoogleMapAPI_Km",
    LINK_NAME: "แสดงแผนที่_GoogleMapsRoutesAPI",
    DEPOT_DISTANCE_NAME: "ระยะทางจากคลัง_Km",
    ID_RESULT_NAME: "ID_ทำเบิกส่วนต่างScgวังน้อย",
    FIRST_DEST_NAME: "Lat/Long_ปลายทาง_01"
  }),

  CANDIDATE_COUNT: 3,
  LOCK_TIMEOUT_MS: 30000,
  MAX_WAYPOINTS_DETAIL_COLS: 20
});

// =================================================================
// [ 2 ] MAIN ENTRY POINT
// =================================================================
function findOptimalRouteUsingExistingDistance(shipmentId, rowId) {
  const lock = LockService.getScriptLock();
  try {
    // ⚠️ [C10] ล็อกครอบทั้ง flow รวม API call — ล็อกค้างนานต่อ 1 งาน
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
      throw new Error(`[Concurrency Error] Lock timeout for Shipment: ${shipmentId}`);
    }

    Logger.log(`--- Starting Candidate-Based Route Engine for Shipment: ${shipmentId}, Row: ${rowId} ---`);

    if (!shipmentId || !rowId) {
      throw new Error(`[Invalid Input] shipmentId and rowId are required.`);
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

    const waypointsWithDistance = prepareWaypointsWithExistingDistance(ss, shipmentId);
    if (waypointsWithDistance.length <= 1) {
      throw new Error(`[Data Error] No valid destination waypoints found for Shipment: ${shipmentId}`);
    }

    // ⚠️ [C1] เปลี่ยน business rule: Top-3 candidates แล้วเลือกระยะรวมสั้นสุด
    const candidateTrials = buildCandidateTrials(waypointsWithDistance, CONFIG.CANDIDATE_COUNT);

    // ⚠️ [C3] ยิง API x3 ทุกครั้ง = ต้นทุน x3
    const bestResult = evaluateCandidateRoutesParallel(candidateTrials);

    const resultSheet = ss.getSheetByName(CONFIG.SHEET_RESULT);
    if (!resultSheet) throw new Error(`[Sheet Error] Result sheet '${CONFIG.SHEET_RESULT}' not found.`);

    writeResultsToSheetBatch(resultSheet, rowId, bestResult.orderedWaypoints, bestResult.totalDistance, bestResult.googleMapsLink);

    return {
      Status: "Success",
      CalculatedDistanceKm: bestResult.totalDistance,
      GoogleMapsLink: bestResult.googleMapsLink,
      SelectedDestination: bestResult.candidateName,
      EvaluatedCandidatesCount: candidateTrials.length
    };

  } catch (error) {
    Logger.log(`❌ Error: ${error.message}\nStack: ${error.stack}`);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

// =================================================================
// [ 3 ] DATA PREPARATION & CANDIDATE BUILDER
// =================================================================
function prepareWaypointsWithExistingDistance(ss, shipmentId) {
  const computedSheet = ss.getSheetByName(CONFIG.SHEET_COMPUTED);
  if (!computedSheet) throw new Error(`[Sheet Error] Computed sheet '${CONFIG.SHEET_COMPUTED}' not found.`);

  const lastRow = computedSheet.getLastRow();
  const lastCol = computedSheet.getLastColumn();
  if (lastRow < 2) return [];

  const header = computedSheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const shipmentColIdx = header.indexOf("Shipment No");
  const latlngColIdx = header.indexOf("จุดส่งสินค้าปลายทาง");
  const nameColIdx = header.indexOf("ชื่อปลายทาง");
  const distanceColIdx = header.indexOf(CONFIG.COLUMNS.DEPOT_DISTANCE_NAME);

  if (shipmentColIdx === -1 || latlngColIdx === -1) {
    throw new Error("[Schema Error] Required columns not found.");
  }

  const numRowsToSearch = lastRow - 1;
  const searchRange = computedSheet.getRange(2, shipmentColIdx + 1, numRowsToSearch, 1);
  const matches = searchRange.createTextFinder(String(shipmentId).trim()).matchEntireCell(true).findAll();

  const allPoints = [{
    id: 0,
    name: CONFIG.DEPOT_COORDS.name,
    original: { lat: CONFIG.DEPOT_COORDS.lat, lng: CONFIG.DEPOT_COORDS.lng },
    forApi: { location: { latLng: { latitude: CONFIG.DEPOT_COORDS.lat, longitude: CONFIG.DEPOT_COORDS.lng } } },
    distance: 0,
    isDepot: true
  }];

  let idCounter = 1;
  const invalidRows = [];

  matches.forEach(match => {
    const rowIdx = match.getRow();
    // ⚠️ [C5] REGRESSION: N+1 read — getRange ทีละแถวในลูป (V2/V3 แก้ไปแล้ว)
    const rowValues = computedSheet.getRange(rowIdx, 1, 1, lastCol).getValues()[0];
    const latlngRaw = rowValues[latlngColIdx];

    if (!latlngRaw) {
      invalidRows.push({ row: rowIdx, reason: "Empty Coordinate Cell" });
      return;
    }

    const cleanedLatLong = String(latlngRaw).trim().replace(/[^\d.,-]/g, "");
    if (cleanedLatLong.includes(",")) {
      const parts = cleanedLatLong.split(",");
      if (parts.length === 2) {
        // ⚠️ [C6] REGRESSION: parseFloat partial-parse กลับมา (A3 เดิม)
        const lat = parseFloat(parts[0].trim());
        const lng = parseFloat(parts[1].trim());

        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          // ⚠️ [C6] REGRESSION: || 0 กลืน NaN → จุดไกลจริงหลุดจาก Top-3 เงียบๆ
          const distance = (distanceColIdx !== -1) ? (parseFloat(rowValues[distanceColIdx]) || 0) : 0;
          let name = `Point ${idCounter}`;
          if (nameColIdx !== -1 && rowValues[nameColIdx]) {
            name = String(rowValues[nameColIdx]).trim();
          }

          allPoints.push({
            id: idCounter++,
            name: name,
            original: { lat, lng },
            forApi: { location: { latLng: { latitude: lat, longitude: lng } } },
            distance: distance,
            isDepot: false
          });
        } else {
          invalidRows.push({ row: rowIdx, value: latlngRaw, reason: "Invalid Coordinate Bounds" });
        }
      }
    }
    // ⚠️ หมายเหตุ: parts.length !== 2 → เงียบสนิท ไม่แม้แต่ log (silent skip)
  });

  if (invalidRows.length > 0) {
    Logger.log(`⚠️ [Data Warning] Found ${invalidRows.length} invalid coordinate row(s)`);
  }

  return allPoints;
}

function buildCandidateTrials(allPoints, maxCandidates = 3) {
  const depot = allPoints[0];
  const destinations = allPoints.slice(1);

  const sortedByDepotDistance = [...destinations].sort((a, b) => (b.distance || 0) - (a.distance || 0));
  const candidateDestinations = sortedByDepotDistance.slice(0, Math.min(maxCandidates, sortedByDepotDistance.length));

  const trials = candidateDestinations.map(candidate => {
    const intermediates = destinations.filter(p => p.id !== candidate.id);
    return { origin: depot, destination: candidate, intermediates: intermediates };
  });

  return trials;
}

// =================================================================
// [ 4 ] PARALLEL API EVALUATION
// =================================================================
function evaluateCandidateRoutesParallel(candidateTrials) {
  const GOOGLE_MAPS_API_KEY = PropertiesService.getScriptProperties().getProperty("GOOGLE_MAPS_API_KEY");
  if (!GOOGLE_MAPS_API_KEY) throw new Error("[Config Error] Google Maps API Key missing");

  const apiUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";

  const fetchRequests = candidateTrials.map(trial => {
    const shouldOptimize = trial.intermediates.length > 1;
    // ⚠️ [C10] ไม่ตรวจลิมิต 25 intermediates
    const payload = {
      origin: trial.origin.forApi,
      destination: trial.destination.forApi,
      intermediates: trial.intermediates.map(p => p.forApi),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      optimizeWaypointOrder: shouldOptimize
    };

    return {
      url: apiUrl,
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
  });

  // ⚠️ [C4] fetchAll ไม่มี retry — candidate ที่ fail ถูกข้ามเงียบ → ผู้ชนะเปลี่ยนได้ระหว่างรัน
  const responses = UrlFetchApp.fetchAll(fetchRequests);

  let bestRouteResult = null;
  let minDistance = Infinity;

  responses.forEach((response, index) => {
    const trial = candidateTrials[index];
    const statusCode = response.getResponseCode();

    if (statusCode !== 200) {
      Logger.log(`⚠️ [Candidate Trial ${index + 1} Failed] HTTP ${statusCode}`);
      return;   // ⚠️ [C4] ข้ามเงียบ
    }

    const result = JSON.parse(response.getContentText());   // ⚠️ JSON.parse ไม่มี try/catch
    if (!result.routes || result.routes.length === 0) return;

    const route = result.routes[0];
    // ⚠️ [C2] distanceMeters หาย → 0 km → ชนะ minimum เสมอ!
    const totalDistance = (route.distanceMeters || 0) / 1000;

    const orderedWaypoints = [trial.origin];
    if (trial.intermediates.length > 1 && route.optimizedIntermediateWaypointIndex) {
      // ⚠️ [C9] ตรวจแค่ existence — index ไม่ครบ = จุดหายเงียบ
      route.optimizedIntermediateWaypointIndex.forEach(idx => {
        if (trial.intermediates[idx]) orderedWaypoints.push(trial.intermediates[idx]);
      });
    } else {
      orderedWaypoints.push(...trial.intermediates);
    }
    orderedWaypoints.push(trial.destination);

    const linkCoordinates = orderedWaypoints.map(p => `${p.original.lat.toFixed(6)},${p.original.lng.toFixed(6)}`);
    const googleMapsLink = encodeURI(`https://www.google.com/maps/dir/${linkCoordinates.join('/')}`);

    if (totalDistance < minDistance) {
      minDistance = totalDistance;
      bestRouteResult = {
        orderedWaypoints, totalDistance, googleMapsLink,
        winningCandidateId: trial.destination.id,
        candidateName: trial.destination.name
      };
    }
  });

  if (!bestRouteResult) {
    throw new Error("[API Execution Error] All candidate route trials failed.");
  }

  return bestRouteResult;
}

// =================================================================
// [ 5 ] WRITE RESULTS
// =================================================================
function writeResultsToSheetBatch(resultSheet, rowId, orderedPoints, totalDistance, googleMapsLink) {
  const lastCol = resultSheet.getLastColumn();
  const resultHeader = resultSheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const idIndex = resultHeader.indexOf(CONFIG.COLUMNS.ID_RESULT_NAME);
  const mainResultColIndex = resultHeader.indexOf(CONFIG.COLUMNS.RESULT_NAME);
  const distanceColIndex = resultHeader.indexOf(CONFIG.COLUMNS.DISTANCE_NAME);
  const linkColIndex = resultHeader.indexOf(CONFIG.COLUMNS.LINK_NAME);
  const firstDestColIndex = resultHeader.indexOf(CONFIG.COLUMNS.FIRST_DEST_NAME);

  if (idIndex === -1) throw new Error(`[Schema Error] ID column not found`);

  const lastRow = resultSheet.getLastRow();
  if (lastRow < 2) throw new Error(`[Data Error] Result Sheet has no data rows.`);

  const idRange = resultSheet.getRange(2, idIndex + 1, lastRow - 1, 1);
  const idMatch = idRange.createTextFinder(String(rowId).trim()).matchEntireCell(true).findNext();
  if (!idMatch) throw new Error(`[Data Error] Target row not found for ID: ${rowId}`);

  const rowIndexInSheet = idMatch.getRow();
  // ⚠️ [C8] read-modify-write ทั้งแถว — ทับค่าที่ AppSheet แก้ระหว่าง read→write
  const rowValues = resultSheet.getRange(rowIndexInSheet, 1, 1, lastCol).getValues()[0];

  const resultString = orderedPoints.map(p => `${p.original.lat.toFixed(6)}, ${p.original.lng.toFixed(6)}`).join(" | ");

  // ⚠️ คอลัมน์หลักหาย → ข้ามเงียบ (silent skip เดิมของ V1 กลับมา)
  if (mainResultColIndex !== -1) rowValues[mainResultColIndex] = resultString;
  if (distanceColIndex !== -1) rowValues[distanceColIndex] = totalDistance;
  if (linkColIndex !== -1) rowValues[linkColIndex] = googleMapsLink;

  if (firstDestColIndex !== -1) {
    const customersOnly = orderedPoints.slice(1);
    const maxCols = CONFIG.MAX_WAYPOINTS_DETAIL_COLS;

    for (let i = 0; i < maxCols; i++) {
      // ⚠️ [C7] positional เพียวๆ — ไม่ตรวจว่าคอลัมน์ที่ i คือ Lat/Long_ปลายทาง จริงไหม
      const targetColIdx = firstDestColIndex + i;
      if (targetColIdx < lastCol) {
        if (i < customersOnly.length) {
          const p = customersOnly[i];
          rowValues[targetColIdx] = `${p.original.lat.toFixed(6)}, ${p.original.lng.toFixed(6)}`;
        } else {
          rowValues[targetColIdx] = "";
        }
      }
    }
  }

  resultSheet.getRange(rowIndexInSheet, 1, 1, lastCol).setValues([rowValues]);

  Logger.log(`✅ [Batch Write Success] Updated Row ${rowIndexInSheet}`);
}
