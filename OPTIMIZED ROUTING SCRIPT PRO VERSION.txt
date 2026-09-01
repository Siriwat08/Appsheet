/**
 * OPTIMIZED ROUTING SCRIPT (PRO VERSION)
 * - รูปแบบ Format แน่นอน (String: Lat, Lng | Lat, Lng / Link: Lat,Lng/Lat,Lng)
 * - ใช้ TextFinder เร่งความเร็วการอ่านข้อมูล
 * - โหมดจราจร: TRAFFIC_UNAWARE (มาตรฐานสำหรับเบิกเงิน)
 * - V8 Engine Support & Optional Chaining
 */

// =================================================================
// [ 1 ] CONFIGURATION
// =================================================================
const SPREADSHEET_ID = "1CYtLpXn6gNYgbGu3oRF8CW5KkGYHQJ6D4jl9u2LiR6o";
const SHEET_COMPUTED = "SCGนครหลวงJWDภูมิภาค";
const SHEET_RESULT = "ทำเบิกส่วนต่างScgวังน้อย";

const DEPOT_COORDS = {
  lat: 14.1646106,
  lng: 100.6254644,
  name: "คลังสินค้า เอสซีจี เจดับเบิ้ลยูดี วังน้อย"
};

const RESULT_COLUMN_NAME = "GoogleMapsRoutesAPI";
const DISTANCE_COLUMN_NAME = "ระยะทาง_GoogleMapAPI_Km";
const LINK_COLUMN_NAME = "แสดงแผนที่_GoogleMapsRoutesAPI";
const DEPOT_DISTANCE_COLUMN = "ระยะทางจากคลัง_Km"; 

// =================================================================
// [ 2 ] MAIN FUNCTION
// =================================================================
function findOptimalRouteUsingExistingDistance(shipmentId, rowId) {
  try {
    Logger.log(`--- Starting PRO Calculation for Shipment: ${shipmentId}, Row: ${rowId} ---`);
    
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    
    // 1. เตรียมข้อมูลแบบจรวดด้วย TextFinder
    const waypointsWithDistance = prepareWaypointsWithExistingDistance(ss, shipmentId);
    if (waypointsWithDistance.length <= 1) throw new Error(`No valid waypoints found for Shipment: ${shipmentId}`);
    
    // 2. จัดลำดับ (ไกลสุดเป็นปลายทาง)
    const { orderedPoints } = selectFinalDestinationAndSort(waypointsWithDistance);
    
    // 3. ยิง API (ระบบมาตรฐาน TRAFFIC_UNAWARE)
    const result = executeGoogleMapsRoutesAPIOneWay(orderedPoints);
    
    // 4. บันทึกผล 
    const resultSheet = ss.getSheetByName(SHEET_RESULT);
    writeResultsToSheet(resultSheet, rowId, result.orderedWaypoints, result.totalDistance, result.googleMapsLink);
    
    return {
      Status: "Success",
      CalculatedDistanceKm: result.totalDistance,
      GoogleMapsLink: result.googleMapsLink
    };
    
  } catch (error) {
    Logger.log(`❌ Error: ${error.message}\n${error.stack}`);
    throw error;
  }
}

// =================================================================
// [ 3 ] DATA PREPARATION (TextFinder PRO Mode)
// =================================================================
function prepareWaypointsWithExistingDistance(ss, shipmentId) {
  const computedSheet = ss.getSheetByName(SHEET_COMPUTED);
  
  // โหลด Header แค่บรรทัดเดียว
  const headerRange = computedSheet.getRange(1, 1, 1, computedSheet.getLastColumn());
  const header = headerRange.getValues()[0];
  
  // ตำแหน่งคอลัมน์ (บวก 1 เพราะ Array เริ่มที่ 0 แต่ getRange เริ่มที่ 1)
  const shipmentColIdx = header.indexOf("Shipment No") + 1;
  const latlngColIdx = header.indexOf("จุดส่งสินค้าปลายทาง") + 1;
  const nameColIdx = header.indexOf("ชื่อปลายทาง") + 1;
  const distanceColIdx = header.indexOf(DEPOT_DISTANCE_COLUMN) + 1;
  
  if (shipmentColIdx === 0 || latlngColIdx === 0) throw new Error("Missing required columns in computed sheet");
  
  // จำกัดการค้นหาลงเฉพาะคอลัมน์ Shipment เพื่อความแม่นยำและความเร็วสูงสุด
  const searchRange = computedSheet.getRange(2, shipmentColIdx, computedSheet.getLastRow(), 1);
  const matches = searchRange.createTextFinder(String(shipmentId).trim()).matchEntireCell(true).findAll();
  
  const allPoints = [];
  
  // 1. ใส่ Depot เป็นจุดแรกเสมอ
  allPoints.push({
    id: 0,
    name: DEPOT_COORDS.name,
    original: { lat: DEPOT_COORDS.lat, lng: DEPOT_COORDS.lng },
    forApi: { location: { latLng: { latitude: DEPOT_COORDS.lat, longitude: DEPOT_COORDS.lng } } },
    distance: 0, 
    isDepot: true
  });
  
  let idCounter = 1;

  // วนลูปดึงข้อมูลเฉพาะแถวที่ TextFinder เจอ
  matches.forEach(match => {
    const rowIdx = match.getRow();
    const latlngRaw = computedSheet.getRange(rowIdx, latlngColIdx).getValue();
    
    if (!latlngRaw) return; // ข้ามถ้าไม่มีพิกัด
    
    // ทำความสะอาดตัวอักษรขยะ
    const cleanedLatLong = String(latlngRaw).trim().replace(/[^\d.,-]/g, "");
    if (cleanedLatLong.includes(",")) {
      const parts = cleanedLatLong.split(",");
      if (parts.length === 2) {
        const lat = parseFloat(parts[0].trim());
        const lng = parseFloat(parts[1].trim());
        
        if (!isNaN(lat) && !isNaN(lng)) {
          // ดึงข้อมูลเสริมด้วย optional (รองรับกรณีคอลัมน์หายไป)
          const distance = distanceColIdx > 0 ? parseFloat(computedSheet.getRange(rowIdx, distanceColIdx).getValue()) || 0 : 0;
          let name = `Point ${idCounter}`;
          if (nameColIdx > 0) {
            const rawName = computedSheet.getRange(rowIdx, nameColIdx).getValue();
            if (rawName) name = String(rawName).trim();
          }

          allPoints.push({
            id: idCounter++,
            name: name,
            original: { lat, lng },
            forApi: { location: { latLng: { latitude: lat, longitude: lng } } },
            distance: distance,
            isDepot: false
          });
        }
      }
    }
  });
  
  return allPoints;
}

function selectFinalDestinationAndSort(allPoints) {
  const depot = allPoints[0];
  const destinations = allPoints.slice(1);
  
  // เรียงตามระยะทางจากคลัง (มาก -> น้อย)
  destinations.sort((a, b) => (b.distance || 0) - (a.distance || 0));

  const finalDestination = destinations[0]; 
  const intermediates = destinations.filter(p => p !== finalDestination);
  
  return { 
    orderedPoints: [depot, ...intermediates, finalDestination], 
    finalDestination, 
    intermediates 
  };
}

// =================================================================
// [ 4 ] API EXECUTION
// =================================================================
function executeGoogleMapsRoutesAPIOneWay(allPoints) {
  const GOOGLE_MAPS_API_KEY = PropertiesService.getScriptProperties().getProperty("GOOGLE_MAPS_API_KEY");
  if (!GOOGLE_MAPS_API_KEY) throw new Error("Google Maps API Key not set in Script Properties");
  
  const origin = allPoints[0];
  const finalDestination = allPoints[allPoints.length - 1];
  const intermediates = allPoints.slice(1, -1);
  
  const shouldOptimize = intermediates.length > 1;

  const payload = {
    origin: origin.forApi,
    destination: finalDestination.forApi,
    intermediates: intermediates.map(p => p.forApi),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE', // รักษาระบบมาตรฐานเพื่อใบเสร็จที่ตรงกัน 100% เสมอ
    optimizeWaypointOrder: shouldOptimize
  };
  
  const apiUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(apiUrl, options);
  if (response.getResponseCode() !== 200) throw new Error(`API Error: ${response.getContentText()}`);
  
  const result = JSON.parse(response.getContentText());
  const route = result.routes[0];
  const totalDistance = (route.distanceMeters || 0) / 1000;
  
  // จัดเรียงเส้นทางตามที่ Google Optimization แนะนำ
  const orderedWaypoints = [origin];
  if (shouldOptimize && route.optimizedIntermediateWaypointIndex) {
    route.optimizedIntermediateWaypointIndex.forEach(index => {
      if (intermediates[index]) orderedWaypoints.push(intermediates[index]);
    });
  } else {
    orderedWaypoints.push(...intermediates);
  }
  orderedWaypoints.push(finalDestination);
  
  // สร้าง Link และป้องกัน URL ล้นทะลุด้วย encodeURI (ไม่มีเว้นวรรค)
  const linkCoordinates = orderedWaypoints.map(p => `${p.original.lat.toFixed(6)},${p.original.lng.toFixed(6)}`);
  const rawMapsLink = `https://www.google.com/maps/dir/${linkCoordinates.join('/')}`;
  const googleMapsLink = encodeURI(rawMapsLink);
  
  return { orderedWaypoints, totalDistance, googleMapsLink };
}

// =================================================================
// [ 5 ] WRITE RESULTS (Safe Batch & Optional Chaining Mode)
// =================================================================
function writeResultsToSheet(resultSheet, rowId, orderedPoints, totalDistance, googleMapsLink) {
  const resultHeader = resultSheet.getRange(1, 1, 1, resultSheet.getLastColumn()).getValues()[0];
  
  const idIndex = resultHeader.indexOf('ID_ทำเบิกส่วนต่างScgวังน้อย');
  const mainResultColIndex = resultHeader.indexOf(RESULT_COLUMN_NAME);
  const distanceColIndex = resultHeader.indexOf(DISTANCE_COLUMN_NAME);
  const linkColIndex = resultHeader.indexOf(LINK_COLUMN_NAME);
  const firstDestColIndex = resultHeader.indexOf('Lat/Long_ปลายทาง_01');

  if (idIndex === -1) throw new Error(`Column ID not found in Result Sheet`);
  
  // ดึงคอลัมน์ ID มาหาบรรทัดด้วย TextFinder จะเร็วกว่าดึงทั้งชีต
  const idRange = resultSheet.getRange(2, idIndex + 1, resultSheet.getLastRow(), 1);
  const idMatch = idRange.createTextFinder(String(rowId).trim()).matchEntireCell(true).findNext();
  if (!idMatch) throw new Error(`Row not found for ID: ${rowId}`);
  
  const rowIndexInSheet = idMatch.getRow();
  
  // สร้างผลลัพธ์ String (เว้นวรรคหลังคอมม่า, คั่นด้วยลากเตะ |)
  const resultString = orderedPoints.map(p => `${p.original.lat.toFixed(6)}, ${p.original.lng.toFixed(6)}`).join(" | ");
  
  // อัปเดตข้อมูลทีละเซลล์อย่างปลอดภัย (หลีกเลี่ยงการเขียนทับสูตรของค่ายื่นเบิก)
  if (mainResultColIndex !== -1) resultSheet.getRange(rowIndexInSheet, mainResultColIndex + 1).setValue(resultString);
  if (distanceColIndex !== -1) resultSheet.getRange(rowIndexInSheet, distanceColIndex + 1).setValue(totalDistance);
  if (linkColIndex !== -1) resultSheet.getRange(rowIndexInSheet, linkColIndex + 1).setValue(googleMapsLink);
  
  // เขียนแยกช่อง (Lat/Long_ปลายทาง_01...20) แบบ Batch Writing (ยิงอาเรย์ทีเดียว 20 หลุม)
  if (firstDestColIndex !== -1) {
    const customersOnly = orderedPoints.slice(1);
    const maxColumns = 20;
    const valuesToWrite = new Array(maxColumns).fill(''); // สร้างที่ว่าง 20 ช่องรอไว้
    
    customersOnly.forEach((p, i) => {
      if (i < maxColumns) valuesToWrite[i] = `${p.original.lat.toFixed(6)}, ${p.original.lng.toFixed(6)}`;
    });
    
    // ยิงเขียนทีเดียว 20 คอลัมน์รวด (Batch Optimization)
    resultSheet.getRange(rowIndexInSheet, firstDestColIndex + 1, 1, maxColumns).setValues([valuesToWrite]);
  }
  
  Logger.log(`✅ Updated Row ${rowIndexInSheet} | Distance: ${totalDistance} | String: ${resultString.substring(0, 50)}...`);
}
