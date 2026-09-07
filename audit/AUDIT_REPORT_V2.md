# รายงานตรวจรับโค้ด V2 (FIXED) — Final Acceptance Audit

**ผู้ตรวจ:** GenSpark AI Developer (ผู้ตรวจรับรอบสุดท้าย)
**วันที่:** 2026-09-07
**ขอบเขต:** ตรวจโค้ด "OPTIMIZED ROUTING SCRIPT PRO VERSION 2.0 (FIXED)" ที่ AI ท่านอื่นจัดทำ
เทียบกับต้นฉบับ `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs` (259 บรรทัด) แบบบรรทัดต่อบรรทัด
**ผลสรุป:** ❌ **ไม่ผ่านการตรวจรับ** — พบข้อบกพร่อง 4 จุด (1 จุดเป็นบั๊กใหม่ที่ V2 ใส่เข้ามาเอง)
→ จัดทำ **V3** (`OPTIMIZED ROUTING SCRIPT PRO VERSION 3.gs`) แก้ครบทั้ง 4 จุด + ยืนยันด้วย unit test 30 ข้อ (ผ่านทั้งหมด)

---

## 1) สิ่งที่ V2 แก้ "ถูกต้อง" (ยอมรับและคงไว้ใน V3)

| # | รายการ | สถานะ |
|---|--------|--------|
| 1 | Batch read แทน N+1 (อ่านทีละเซลล์ในลูป) | ✅ ถูกต้อง (แต่มีจุดอ่อน A4 — ดูข้อ 2) |
| 2 | Header map + ชื่อคอลัมน์เป็น constant ทั้งหมด | ✅ ถูกต้อง |
| 3 | ตรวจ `routes[]` ว่างก่อนใช้ (แก้ TypeError เงียบของ V1 บรรทัด 193) | ✅ ถูกต้อง |
| 4 | `fetchWithRetry_` + exponential backoff เฉพาะ 429/5xx | ✅ ถูกต้อง |
| 5 | คอลัมน์ผลลัพธ์หลักขาด → throw (แทนการข้ามเงียบของ V1) | ✅ ถูกต้อง |
| 6 | แก้ off-by-one `getRange(2, col, lastRow, 1)` → `lastRow - 1` | ✅ ถูกต้อง |
| 7 | ระยะจากคลังใช้ไม่ได้ → Haversine fallback (แทน `\|\| 0` เงียบของ V1) | ✅ ถูกต้อง |
| 8 | LockService ครอบการเขียน / Warning & Status columns / รวมพิกัดซ้ำ | ✅ ถูกต้อง |
| 9 | API key + Spreadsheet ID จาก Script Properties | ✅ ถูกต้อง |
| 10 | สร้างชื่อคอลัมน์ `Lat/Long_ปลายทาง_01..20` ด้วย padStart | ✅ ตรวจสอบแล้วถูกต้อง |
| 11 | แปลง duration `"5400s"` → 90 นาที | ✅ ตรวจสอบแล้วถูกต้อง |

## 2) ข้อบกพร่องที่พบใน V2 (ตรวจยืนยันด้วยการรันโค้ดจริงใน Node.js)

### 🔴 [A1] Cache hit คืนผล "ก่อน" เขียนชีต + key ไม่มี rowId — **บั๊กใหม่ที่ V2 ใส่เข้ามาเอง** (Critical)
```javascript
// V2:
const cacheKey = `route_${shipmentId}`;       // ← ไม่มี rowId
if (cached) { return JSON.parse(cached); }    // ← ออกก่อนถึง writeResultsPro_ !
```
**ผลกระทบ:** ผู้ใช้สร้างแถวเบิกใหม่ (rowId ใหม่) ของ shipment เดิมภายใน 6 ชม. →
Bot ได้ `Status: "Success"` กลับไป แต่ **เซลล์ในชีตแถวนั้นว่างเปล่าทั้งแถว** = silent failure รูปแบบใหม่
ที่ต้นฉบับ V1 ไม่เคยมี (V1 ไม่มี cache จึงเขียนชีตทุกครั้ง)

**V3 แก้:** cache เก็บเฉพาะ "ผลจาก API" — การเขียนชีตตาม rowId ทำ**ทุกครั้ง**ไม่ว่าจะ hit หรือ miss
พร้อมตรวจโครงสร้าง cache ก่อนใช้ (cache เสียหาย → คำนวณใหม่ ไม่ crash)

### 🔴 [A2] Batch write 20 คอลัมน์ ตรวจแค่ "มีครบ" ไม่ตรวจ "ติดกัน" (High)
```javascript
// V2: presence check เท่านั้น
const allPresent = destCols.every(c => c !== undefined);
// ...แล้ว setValues 20 ช่องต่อเนื่องจาก destCols[0] ทันที
```
**พิสูจน์:** สมมุติผู้ใช้แทรกคอลัมน์ "หมายเหตุ" ระหว่าง `_05` กับ `_06` →
`allPresent = true` (ทุกหัวคอลัมน์ยังอยู่) แต่เลขคอลัมน์ไม่ติดกัน →
batch write **เขียนทับคอลัมน์หมายเหตุ** และพิกัดทุกช่องหลังจุดแทรกเคลื่อนผิดตำแหน่งหมด
— นี่คือความเสี่ยงเดิมของ V1 ที่ V2 อ้างว่าแก้แล้วแต่**แก้ไม่ครบ**

**V3 แก้:** ตรวจ `contiguous = destCols.every((c, i) => c === destCols[0] + i)` —
ติดกัน → batch (เร็ว), ไม่ติดกัน → เขียนทีละเซลล์ตามตำแหน่งจริง (ถูกต้องเสมอ) + บันทึก warning

### 🔴 [A3] parseFloat แบบ partial-parse ยังหลุดรอด validation (High)
```javascript
// V2: parseFloat("14.16-46106") → 14.16  ← ไม่ใช่ NaN!
// 14.16 อยู่ในช่วงโลกจริง ✓ อยู่ในกล่องไทย (5–21) ✓ → ผ่านทุกด่าน
```
**ผลกระทบ:** ข้อมูลพิกัดพิมพ์ผิด (ขีดกลางแทนจุด, จุดซ้ำ) → ได้พิกัดผิดที่ "ดูสมเหตุสมผล" →
เส้นทาง/ระยะทาง/ยอดเบิกผิดแบบตรวจไม่เจอ — silent error คลาสเดียวกับที่รายงานตรวจ V1 ชี้ไว้ V2 ยังแก้ไม่หมด

**V3 แก้:** ตรวจ regex เข้มงวดทีละส่วน `^-?\d{1,3}(\.\d+)?$` **ก่อน** parseFloat
(ทดสอบแล้ว: `"14.16-46106"` และ `"14.1.2"` ถูก reject, `"14.1646106"` ผ่าน)
รวมถึงค่าระยะทางจากชีตก็ตรวจเข้มงวดเช่นกัน (`"123abc"` ถูก reject)

### 🟡 [A4] Block read min→max row ไม่มี guard ช่วงแถว (Medium — performance/memory)
```javascript
// V2: match แถว 2 และแถว 48,000 → อ่านบล็อกเดียว 47,999 แถว x ทุกคอลัมน์
const block = sheet.getRange(minRow, 1, maxRow - minRow + 1, lastCol).getValues();
```
**ผลกระทบ:** ข้อมูล shipment กระจายในชีตใหญ่ → อ่านหน่วยความจำมหาศาล เสี่ยง timeout/quota

**V3 แก้:** `readMatchedRowsClustered_` — จับกลุ่มแถวที่ห่างกัน ≤ 50 แถวเป็น cluster
อ่านทีละบล็อกเล็ก + อ่านเฉพาะช่วงคอลัมน์ที่ใช้จริง (minCol..maxCol) ไม่ใช่ทุกคอลัมน์
(ทดสอบแล้ว: แถว [2, 48000] → อ่านแค่ 2 แถว ไม่ใช่ 47,999)

## 3) การตรวจสอบยืนยัน (Verification)

- `node --check` ผ่านทั้ง V3 และไฟล์ archive V2 (syntax ถูกต้อง 100%)
- Unit test 30 ข้อครอบคลุมทั้ง 4 FIX — **ผ่านทั้งหมด (30/30)**:
  - FIX-A3: 13 เคสพิกัด (valid/partial-parse/(0,0)/นอกโลก/นอกไทย/ขยะ/วงเล็บ)
  - FIX-A2: 4 เคสโหมดเขียน (ติดกัน→batch, แทรก→per-cell, ขาด→partial, สลับ→per-cell)
  - FIX-A4: 4 เคส cluster (กระจาย→2 บล็อก 2 แถว, ใกล้กัน→1 บล็อก, แถวเดียว)
  - FIX-A1: จำลอง flow — cache hit ครั้งที่ 2 ยังเขียนชีต (2 แถว = 2 การเขียน)
  - เสริม: ตรวจระยะทางเข้มงวด 6 เคส + duration parse 2 เคส

## 4) Business rules ที่คงไว้ตามเดิม (ไม่เปลี่ยนโดยไม่มีการอนุมัติ)

- `routingPreference: TRAFFIC_UNAWARE` — ผลคงที่ (deterministic) เพื่อการตรวจสอบเบิกย้อนหลัง
- จุดไกลสุดจากคลัง = ปลายทางสุดท้าย (one-way ไม่วนกลับคลัง)
- `optimizeWaypointOrder` เฉพาะจุดระหว่างกลาง (Advanced SKU — ใช้ได้กับ TRAFFIC_UNAWARE)

## 5) ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | บทบาท |
|------|--------|
| `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs` | ต้นฉบับ V1 (เก็บไว้อ้างอิง) |
| `audit/V2_FIXED_from_chat.gs` | V2 ของ AI ท่านอื่น + คำอธิบายจุดบกพร่อง (archive — ห้ามใช้งานจริง) |
| **`OPTIMIZED ROUTING SCRIPT PRO VERSION 3.gs`** | **เวอร์ชันใช้งานจริง — ผ่านการตรวจรับแล้ว** |
| `audit/AUDIT_REPORT_V2.md` | รายงานฉบับนี้ |
