import json, uuid, urllib.request

wf_path = r"H:\lumen-light\lumen-light\workflows\anima工作流-api.json"
with open(wf_path, "r", encoding="utf-8") as f:
    prompt = json.load(f)

# 英文标签提示词：亚丝娜站在樱花树下
positive = ("Asuna Yuuki, Sword Art Online, standing under a cherry blossom tree, "
            "sakura tree in full bloom, pink cherry blossom petals falling, "
            "anime style, masterpiece, best quality, highly detailed, beautiful lighting")
negative = ("lowres, bad anatomy, bad hands, extra fingers, blurry, watermark, text, "
            "worst quality, low quality, jpeg artifacts, deformed")

prompt["604"]["inputs"]["text"] = positive
prompt["602"]["inputs"]["text"] = negative
prompt["862"]["inputs"]["width"] = 1024
prompt["862"]["inputs"]["height"] = 1024

client_id = str(uuid.uuid4())
payload = {"prompt": prompt, "client_id": client_id}
data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(
    "http://127.0.0.1:8188/prompt",
    data=data,
    headers={"Content-Type": "application/json"},
)
resp = urllib.request.urlopen(req, timeout=60)
print(resp.read().decode("utf-8"))
