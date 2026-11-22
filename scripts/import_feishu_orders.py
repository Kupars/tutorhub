"""Convert the publicly shared '单子' sheet into board records, never '老师'.

Usage: python scripts/import_feishu_orders.py path/to/workbook.xlsx
The output contains public order content only, with unique internal IDs.
"""
import json
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "imported-orders.json"
DISTRICTS = (
    "和平区", "河西区", "南开区", "河东区", "河北区", "红桥区",
    "津南区", "西青区", "东丽区", "北辰区", "武清区", "滨海新区",
    "宝坻区", "静海区", "宁河区", "蓟州区", "丰台区", "海淀区",
    "朝阳区", "徐汇区",
)
GRADE_TERMS = (
    "高三", "高二", "高一", "初三", "初二", "初一", "小学六年级", "小学五年级",
    "小学四年级", "小学三年级", "小学二年级", "小学一年级", "六年级", "五年级",
    "四年级", "三年级", "二年级", "一年级", "幼儿园", "小学",
)


def cell(value):
    return "" if pd.isna(value) else str(value).strip()


def main(path):
    rows = pd.read_excel(path, sheet_name="单子", header=None)
    records = []
    for row_index, row in rows.iloc[2:].iterrows():
        source = cell(row.iloc[1])
        if "【补习科目】" not in source or "【补课地址】" not in source:
            continue
        fields = {k.strip(): v.strip() for k, v in re.findall(r"【([^】]+)】([^\n\r]*)", source)}
        order_number = cell(row.iloc[0]) or (re.search(r"#\d+(?:-\d+)?", source) or [""])[0]
        if not order_number.startswith("#"):
            order_number = "#" + order_number
        headline = source.splitlines()[0].strip()
        headline = re.sub(r"^#\d+(?:-\d+)?(?:[^\w\u4e00-\u9fa5]*)/?\s*", "", headline)
        grade_sex = fields.get("年级性别", "")
        grade = next((term for term in GRADE_TERMS if term in grade_sex), cell(row.iloc[3]) or "年级待补充")
        address = fields.get("补课地址", "")
        district = next((d for d in DISTRICTS if d in address), "")
        if not district:
            hint = cell(row.iloc[4]).replace("区", "")
            district = next((d for d in DISTRICTS if d.startswith(hint) and hint), "")
        if not district:
            district = "线上" if re.search(r"网课|线上", address) else "区域待补充"
        gender_hint = cell(row.iloc[2])
        gender = "男生" if re.search(r"男孩|男生", grade_sex) or gender_hint == "男" else (
            "女生" if re.search(r"女孩|女生", grade_sex) or gender_hint == "女" else "待补充"
        )
        subject = fields.get("补习科目", "") or cell(row.iloc[5]) or "科目待补充"
        salary = fields.get("薪资", "") or "老师报价"
        hours = re.search(r"\d+(?:\.\d+)?", fields.get("每次几小时", ""))
        teachers = re.search(r"\d+", fields.get("需要几个老师", ""))
        rate = re.search(r"\d+", salary)
        online = bool(re.search(r"网课|线上", address))
        record = {
            "id": f"fs-{row_index+1:04d}",
            "orderNumber": order_number,
            "source": "feishu-public-orders",
            "title": headline or f"{grade}{subject}家教",
            "grade": grade,
            "studentGender": gender,
            "subject": subject,
            "teacherCount": int(teachers.group()) if teachers else 1,
            "currentScores": fields.get("现阶段成绩", "成绩待补充"),
            "publicAddress": address,
            "address": address,
            "district": district,
            "weeklyFrequency": fields.get("一周几次", "待协商"),
            "hoursPerSession": float(hours.group()) if hours else 2,
            "requirements": fields.get("对老师要求", "无特殊要求"),
            "salaryText": salary,
            "hourlyRate": int(rate.group()) if rate else 0,
            "trialTime": fields.get("试课时间", ""),
            "notes": fields.get("其他说明", ""),
            "mode": "线上" if online else "上门",
            "onlineAllowed": "#可网课" in source,
            "urgent": "急急" in source or "急招" in source,
            "status": "待确认",
            "createdAt": "2026-11-22T00:00:00Z",
        }
        records.append(record)

    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Imported {len(records)} public tutoring orders into {OUTPUT}")
    print(f"Unique internal IDs: {len({r['id'] for r in records})}; unique visible numbers: {len({r['orderNumber'] for r in records})}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python scripts/import_feishu_orders.py workbook.xlsx")
    main(sys.argv[1])
