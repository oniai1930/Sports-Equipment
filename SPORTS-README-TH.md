# Sports Equipment Box — ระบบยืมคืนอุปกรณ์กีฬา

รายการเริ่มต้นในฐานข้อมูลใหม่:
- ไม้แบดมินตัน 10 อัน
- วอลเลย์บอล 2 ลูก
- ฟุตบอล 1 ลูก
- เปตอง 2 ชุด

ยืมและคืนเป็นจำนวนได้ รวมถึงคืนบางส่วน โดยรายการยืมแยกตามผู้ยืมและคงค้างใน SQLite

**สำคัญ:** หากใช้ฐานข้อมูลเก่าที่มีอยู่ ระบบจะไม่ลบข้อมูลเดิมหรือเปลี่ยนจำนวนอัตโนมัติ ควรสำรองไฟล์ .db ก่อนอัปเดต และตั้งค่ารายการให้ตรงกับอุปกรณ์จริง

## อัปโหลด GitHub ผ่านเว็บ
1. แตกไฟล์ ZIP แล้วเปิดโฟลเดอร์ SportsEquipmentBox
2. เข้า github.com และสร้าง Repository ใหม่ หรือเปิด Repository เดิม
3. เลือก Add file > Upload files แล้วลากไฟล์และโฟลเดอร์ภายใน SportsEquipmentBox ขึ้นไป (อย่าอัปโหลด .env หรือไฟล์ฐานข้อมูล .db)
4. กด Commit changes
5. ถ้าเชื่อม Render กับ GitHub อยู่ ให้รอ Render Deploy หรือกด Manual Deploy > Deploy latest commit
6. บน Render ควรตั้ง Persistent Disk สำหรับ SQLite เพื่อไม่ให้ข้อมูลหายเมื่อ Deploy/Restart

ทดสอบในเครื่อง: npm install แล้ว npm start จาก PowerShell ในโฟลเดอร์โปรเจกต์
