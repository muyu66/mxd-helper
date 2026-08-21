# ocr_service.py — OCR 识别常驻服务（server.js 的 POST /api/ocr 内部调用，不单独运行）
#
# 常驻进程设计（适配 2核2G 小服务器）：模型只加载一次，进程长期存活，
# 避免每次识别都新起 python 进程 + 重复加载 onnxruntime（单次峰值约 600MB，
# 并发/频繁调用时会把小内存服务器压到 OOM）。
#
# 协议（stdin/stdout 二进制，长度前缀）：
#   请求：4 字节小端长度 + 图片二进制
#   响应：4 字节小端长度 + JSON（ensure_ascii，Windows GBK 控制台也不乱码）
#   出错不退出进程，以 {"ok": false, "error": ...} 返回；
#   stdin 关闭（server.js 退出）时进程自行结束。
#
# 依赖安装（项目内虚拟环境，Ubuntu 24.04 全局 pip 受限）：
#   python3 -m venv .venv && .venv/bin/pip install rapidocr_onnxruntime
#   sudo apt install python3-venv libgomp1 libgl1
import json
import struct
import sys

MAX_IMAGE = 20 * 1024 * 1024  # 与 server.js 的 OCR_LIMIT 对应，防御异常长度


def write(out, obj):
    payload = json.dumps(obj, ensure_ascii=True).encode("utf-8")
    out.write(struct.pack("<I", len(payload)))
    out.write(payload)
    out.flush()


def main():
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:  # noqa: BLE001
        write(sys.stdout.buffer, {"ok": False, "error": "rapidocr_onnxruntime 未安装：" + str(e)})
        return

    # 小服务器限制推理线程为 1：降低 CPU 争抢与内存峰值（图片识别本身很轻）
    ocr = RapidOCR(params={"EngineConfig.intra_op_num_threads": "1"})

    stdin = sys.stdin.buffer
    out = sys.stdout.buffer
    while True:
        head = stdin.read(4)
        if not head or len(head) < 4:
            break  # server.js 退出（stdin 关闭）→ 常驻进程结束
        n = struct.unpack("<I", head)[0]
        if n <= 0 or n > MAX_IMAGE:
            write(out, {"ok": False, "error": "图片长度异常"})
            continue
        data = stdin.read(n)
        if len(data) < n:
            break
        try:
            result, _ = ocr(data)
            items = []
            for box, text, score in result or []:
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
            write(out, {"ok": True, "items": items})
        except Exception as e:  # noqa: BLE001 —— 单次失败不影响后续识别
            write(out, {"ok": False, "error": str(e)})


main()
