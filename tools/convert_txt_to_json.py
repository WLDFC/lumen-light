#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
提示词词典格式转换工具
========================
作用：将 txt 格式的提示词翻译词典转换为 JSON 格式，供前端提示词补全组件使用。

运行方式：
--------
方式一（推荐）：直接双击本脚本文件运行。
    前提：系统已安装 Python，且 .py 文件默认使用 Python 打开。
    运行后会自动处理脚本所在文件夹（tools 文件夹）内的所有 txt 文件。
方式二：在终端中运行。
    python tools/convert_txt_to_json.py

txt 格式要求：
------------
每行一条词汇，中文和英文用英文逗号分隔，例如：
    1个女孩,1girl
    高分辨率,highres
    单人,solo

注意：
    - 支持空行，空行会被自动跳过。
    - 每行必须包含且仅包含一个英文逗号，用于分隔中文和英文。
    - 英文部分可以包含逗号以外的特殊字符。

转换后的 JSON 格式：
------------------
[
    { "cn": "1个女孩", "en": "1girl" },
    { "cn": "高分辨率", "en": "highres" },
    { "cn": "单人", "en": "solo" }
]

输出规则：
--------
脚本会自动查找脚本所在文件夹下的所有 .txt 文件，
并将每个 txt 文件转换为同名的 .json 文件，保存在同一个文件夹中。
例如：
    tools/prompt-dict.txt  ->  tools/prompt-dict.json
"""

import json
import os
import sys


def convert_single_txt_to_json(input_file, output_file):
    """
    读取单个 txt 提示词词典并转换为 JSON 文件。

    参数：
        input_file  -- str，输入的 txt 文件路径。
        output_file -- str，输出的 JSON 文件路径。

    返回：
        int，成功转换的词汇数量；如果失败则返回 0。
    """
    data = []

    # 以 UTF-8 编码读取 txt 文件，确保中文不会乱码
    with open(input_file, 'r', encoding='utf-8') as f:
        for line_number, line in enumerate(f, start=1):
            # 去除行首行尾空白字符
            line = line.strip()

            # 跳过空行
            if not line:
                continue

            # 按第一个英文逗号拆分，避免英文词组内部包含逗号时拆分错误
            parts = line.split(',', 1)
            if len(parts) != 2:
                print(f'  ⚠️ 第 {line_number} 行格式不正确，已跳过: {line}')
                continue

            # 分别获取中文和英文，并去除多余空格
            cn = parts[0].strip()
            en = parts[1].strip()

            # 两者都不为空才加入结果
            if cn and en:
                data.append({
                    'cn': cn,
                    'en': en
                })

    # 以 UTF-8 编码写入 JSON 文件，确保中文正常显示
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return len(data)


def convert_all_txt_in_script_dir():
    """
    自动查找脚本所在文件夹下的所有 txt 文件，并逐个转换为同名的 json 文件。
    """
    # 获取脚本所在文件夹的绝对路径
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # 查找该文件夹下所有 .txt 文件
    txt_files = [f for f in os.listdir(script_dir) if f.lower().endswith('.txt')]

    if not txt_files:
        print(f'⚠️ 在脚本所在文件夹中没有找到 txt 文件: {script_dir}')
        input('按回车键退出...')
        return

    print(f'📂 脚本所在文件夹: {script_dir}')
    print(f'📄 找到 {len(txt_files)} 个 txt 文件，开始转换...\n')

    total_count = 0
    for txt_file in txt_files:
        input_file = os.path.join(script_dir, txt_file)
        # 将扩展名 .txt 替换为 .json
        json_file = os.path.splitext(txt_file)[0] + '.json'
        output_file = os.path.join(script_dir, json_file)

        try:
            count = convert_single_txt_to_json(input_file, output_file)
            print(f'✅ {txt_file} -> {json_file}，共 {count} 条词汇')
            total_count += count
        except Exception as e:
            print(f'❌ 转换失败 {txt_file}: {e}')

    print(f'\n🎉 全部转换完成，累计 {total_count} 条词汇')
    # 暂停，方便双击运行时查看结果
    input('按回车键退出...')


if __name__ == '__main__':
    # 如果通过命令行传参指定了单个 txt 文件，则只转换该文件
    # 例如：python convert_txt_to_json.py my-dict.txt
    if len(sys.argv) >= 2:
        input_file = sys.argv[1]
        output_file = os.path.splitext(input_file)[0] + '.json'
        if not os.path.exists(input_file):
            print(f'❌ 文件不存在: {input_file}')
            input('按回车键退出...')
            sys.exit(1)

        try:
            count = convert_single_txt_to_json(input_file, output_file)
            print(f'✅ 转换完成: {input_file} -> {output_file}，共 {count} 条词汇')
        except Exception as e:
            print(f'❌ 转换失败: {e}')

        input('按回车键退出...')
    else:
        # 默认行为：自动转换脚本所在文件夹下的所有 txt 文件
        convert_all_txt_in_script_dir()
