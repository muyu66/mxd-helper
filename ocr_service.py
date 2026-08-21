# ocr_service.py — OCR 识别服务（server.js 的 POST /api/ocr 内部调用，不单独运行）
#
# 从 stdin 读取图片二进制，用 RapidOCR（onnxruntime + 中文模型，已随 pip 包内置）识别，
# 结果按「上到下、左到右」排序后以 JSON 输出。
# 输出统一 ensure_ascii=True：Windows 控制台 GBK 编码下也不乱码。
#
# 依赖安装（部署新机器时执行一次）：python -m pip install rapidocr_onnxruntime
import json
import sys


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=True))
    sys.exit(1)


def main():
    try:
        data = sys.stdin.buffer.read()
        if not data:
            fail("未收到图片数据")

        # 模型初始化约 0.5s，识别单图约 1~2s；进程级复用交给 server.js 的调用方式
        from rapidocr_onnxruntime import RapidOCR

        ocr = RapidOCR()
        result, _ = ocr(data)
        items = []
        for box, text, score in result or []:
            # box: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            items.append(
                {
                    "text": str(text),
                    "score": round(float(score), 4),
                    "x": round(min(p[0] for p in box), 1),
                    "y": round(min(p[1] for p in box), 1),
                }
            )
        # 同行（y 相差 20px 内）按 x 排序，行间按 y 排序，保持阅读顺序
        items.sort(key=lambda it: (it["y"] // 20 * 20, it["x"]))
        print(json.dumps({"ok": True, "items": items}, ensure_ascii=True))
    except Exception as e:  # noqa: BLE001 —— 任何异常都以 JSON 返回给 Node 端
        fail(str(e))


main()
