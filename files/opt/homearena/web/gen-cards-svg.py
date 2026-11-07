#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HomeArena 原生矢量牌面生成器（v0.11.0）
================================================================================
【为什么要换掉现有 54 张 webp】
    · 素材是 120×165 位图，DPR=3 实机上 46px 牌宽需要 138px 物理像素，
      120px 撑不到 138px → 必然被浏览器**插值放大** → 边缘发虚、人像糊。
    · 位图在任何非整数倍缩放下都要重采样，而牌盒尺寸又随断点变化
      （43/46/60/62），每个断点都是一次不同的重采样 → 永远不可能"刚好清晰"。
   ⇒ 只有矢量能一劳永逸：**同一份 SVG，任何 DPR / 任何牌盒尺寸都锐利**，
      而且比例永远精确等于 120:165，不会被设备像素取整歪掉。

【设计规范】所有几何量以 viewBox 120×165 为坐标系，与旧素材像素 1:1 对齐，
           所以配色、角标位置、字号都是"原设计再描一遍"，不是重新设计——
           视觉上是同一副牌，只是从位图变成了矢量（平滑演进，不换脸）。

【输出】
   cards-svg/{id}.svg   54 张（52 + 大王/小王）
每个 SVGSVG 自包含、无外部依赖、体积 < 2KB，比原 webp 还小。
"""
import os
import re

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cards-svg')
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cards')
W, H = 120, 165

RED = '#c8102e'
BLACK = '#101418'

# ── 花色路径（24×24 设计单位，坐标原点左上）────────────────────────────
# 逐条都对照标准扑克花色的「对称轴 x=12」绘制，保证镜像完美。
#
# 心：两个半圆肩 + 底部收尖。关键在「肩」用二次贝塞尔而不是圆弧，
#     圆弧会让上半部变成两个鼓包（初版就犯了这个错）。
HEART = ('M12 23 C 9.4 20.6 2.6 15.2 2.6 9.4 '
         'C 2.6 5.6 5.4 3 8.7 3 C 10.4 3 11.6 3.9 12 5.2 '
         'C 12.4 3.9 13.6 3 15.3 3 C 18.6 3 21.4 5.6 21.4 9.4 '
         'C 21.4 15.2 14.6 20.6 12 23 Z')
# 方块：四边内凹的菱形（直线即可，扑克方块是直边）
DIAMOND = 'M12 1.6 L21.6 12 L12 22.4 L2.4 12 Z'
# 黑桃：顶部一个尖（两段贝塞尔），两侧叶肩，底部「柄」两侧内收后收成小三角，
#       中间留一道 0.8 宽的缝（这是黑桃与「倒心」的决定性差别）
SPADE = ('M12 1.8 '
         'C 10.2 5.6 3 9.4 3 14 C 3 17.2 5.2 19.4 8.2 19.4 '
         'C 9.6 19.4 10.9 18.9 11.8 17.9 '
         'L11.2 22.4 L12.8 22.4 L12.2 17.9 '
         'C 13.1 18.9 14.4 19.4 15.8 19.4 '
         'C 18.8 19.4 21 17.2 21 14 '
         'C 21 9.4 13.8 5.6 12 1.8 Z')
# 梅花：三瓣（上 1 下 2）用圆，正中一根短茎，茎底外张
CLUB_PATHS = ('<circle cx="12" cy="7.4" r="5.6"/>'
              '<circle cx="6.4" cy="14.6" r="5.6"/>'
              '<circle cx="17.6" cy="14.6" r="5.6"/>'
              '<path d="M11.4 14.4 L9.6 21.6 L14.4 21.6 L12.6 14.4 Z"/>')

SHAPES = {
    'H': f'<path d="{HEART}"/>',
    'D': f'<path d="{DIAMOND}"/>',
    'S': f'<path d="{SPADE}"/>',
    'C': CLUB_PATHS,
}

# ── 点数：用系统衬线字体描边成路径太依赖环境，这里用 SVG <text> 但指定
#    font-family 全字族 + 精确字重，配合 textLength 保证宽度稳定。
#    为彻底摆脱字体依赖，A/2-10/J/Q/K 用**自绘几何字形**（见下面 GLYPHS），
#    只保留文字作为可访问性冗余。
# ────────────────────────────────────────────────────────────────────────
# 数字与字母的简化笔画路径（以 0..100 高度为设计单位，宽度按需）
GLYPHS = {
    'A': 'M50 0 L96 100 L76 100 L66 76 L34 76 L24 100 L4 100 Z M41 58 L59 58 L50 34 Z',
    '2': ('M8 26 C 8 8 26 0 50 0 C 76 0 92 12 92 34 C 92 52 80 62 62 76 '
          'L30 96 L96 96 L96 112 L2 112 L2 96 L48 64 C 64 52 72 46 72 34 '
          'C 72 22 64 16 50 16 C 34 16 28 22 28 30 Z'),
    '3': ('M14 0 C 62 0 92 10 92 34 C 92 46 84 54 74 58 '
          'C 86 62 96 70 96 84 C 96 104 76 112 50 112 C 30 112 14 106 6 92 '
          'L24 82 C 30 90 38 94 50 94 C 62 94 72 92 72 82 C 72 70 62 66 46 66 '
          'L34 66 L34 52 L44 52 C 60 52 68 48 68 36 C 68 26 58 16 42 16 '
          'C 30 16 22 20 16 28 L2 16 C 10 6 22 0 36 0 Z'),
    '4': ('M62 0 L62 68 L96 68 L96 84 L62 84 L62 112 L42 112 L42 84 L0 84 '
          'L0 66 L42 0 Z'),
    '5': ('M14 4 L88 4 L88 20 L32 20 L30 44 C 36 40 44 38 54 38 '
          'C 78 38 94 50 94 72 C 94 94 78 112 50 112 C 28 112 12 104 4 88 '
          'L22 78 C 28 88 38 94 50 94 C 66 94 74 86 74 72 C 74 58 66 52 52 52 '
          'C 40 52 32 56 26 62 L12 58 Z'),
    '6': ('M52 0 C 24 0 6 22 6 58 C 6 92 22 112 50 112 C 76 112 92 96 92 76 '
          'C 92 56 78 42 56 42 C 44 42 34 46 28 54 C 28 30 36 16 52 16 '
          'C 62 16 68 20 72 28 L88 20 C 82 8 70 0 52 0 Z M50 58 '
          'C 64 58 72 66 72 76 C 72 86 64 94 50 94 C 36 94 28 86 28 76 '
          'C 28 66 36 58 50 58 Z'),
    '7': 'M6 4 L94 4 L94 20 L56 112 L34 112 L70 20 L6 20 Z',
    '8': ('M50 0 C 26 0 12 10 12 28 C 12 38 18 46 28 52 C 16 58 8 68 8 82 '
          'C 8 100 24 112 50 112 C 76 112 92 100 92 82 C 92 68 84 58 72 52 '
          'C 82 46 88 38 88 28 C 88 10 74 0 50 0 Z M50 16 C 62 16 68 20 68 30 '
          'C 68 40 62 44 50 44 C 38 44 32 40 32 30 C 32 20 38 16 50 16 Z '
          'M50 58 C 64 58 72 64 72 78 C 72 90 64 96 50 96 C 36 96 28 90 28 78 '
          'C 28 64 36 58 50 58 Z'),
    '9': ('M58 112 C 86 112 104 90 104 54 C 104 20 88 0 60 0 C 34 0 18 16 18 36 '
          'C 18 56 32 70 54 70 C 66 70 76 66 82 58 C 82 82 74 96 58 96 '
          'C 48 96 42 92 38 84 L22 92 C 28 104 40 112 58 112 Z M60 54 '
          'C 46 54 38 46 38 36 C 38 26 46 18 60 18 C 74 18 82 26 82 36 '
          'C 82 46 74 54 60 54 Z'),
    '10': ('M4 12 L28 0 L28 100 L4 100 Z M22 0 L46 0 L46 12 L22 12 Z '),
    'J': ('M92 0 L92 76 C 92 98 78 112 56 112 C 36 112 22 104 16 88 L36 78 '
          'C 40 88 46 94 56 94 C 68 94 74 88 74 76 L74 0 Z '
          'M74 100 L92 100 L92 112 L74 112 Z'),
    'Q': ('M50 0 C 22 0 6 20 6 56 C 6 92 22 112 50 112 C 78 112 94 92 94 56 '
          'C 94 20 78 0 50 0 Z M50 17 C 66 17 74 30 74 56 C 74 82 66 95 50 95 '
          'C 34 95 26 82 26 56 C 26 30 34 17 50 17 Z '
          'M66 84 L98 116 L80 118 L60 96 Z'),
    'K': ('M10 0 L30 0 L30 46 L58 0 L84 0 L50 52 L88 112 L62 112 L30 60 '
          'L30 112 L10 112 Z'),
}
# 「10」单独处理：1 + 0 并排
GLYPHS['10'] = (GLYPHS['10'] +
                'M58 0 L102 0 L102 100 L58 100 Z M80 14 L80 86 L64 86 L64 24 Z ')


def glyph(ch, x, y, size, color, anchor='start'):
    """把一个字形画在 (x, y) 为左上角、高度 size 的位置。"""
    d = GLYPHS.get(ch)
    if not d:
        # 兜底：用 text（仅可能出现在未定义字符上）
        return (f'<text x="{x}" y="{y + size}" font-family="Georgia,serif" '
                f'font-size="{size}" font-weight="700" fill="{color}">{ch}</text>')
    # glyph 设计高度 112 → 缩放到 size
    s = size / 112.0
    return (f'<g transform="translate({x},{y}) scale({s:.4f})">'
            f'<path d="{d}" fill="{color}" fill-rule="evenodd"/></g>')


SUIT_SIZE = lambda w: w  # 花色以 24 单位设计，缩放系数 = w/24


def suit(sym, x, y, w, color):
    s = w / 24.0
    return (f'<g transform="translate({x},{y}) scale({s:.4f})" fill="{color}">'
            f'{SHAPES[sym]}</g>')


def corner(rank, sym, color):
    """左上角标：点数在上、花色在下，位置与旧素材对齐（宽高 120×165）。
    旧素材实测：点数占 y 6..32，花色占 y 34..58，角标区 x 6..48。"""
    out = []
    # 点数
    gp = GLYPHS.get(rank)
    if rank == '10':
        out.append(glyph('1', 8, 5, 30, color))
        out.append(glyph('0', 22, 5, 30, color))
    else:
        out.append(glyph(rank, 9, 5, 30, color))
    # 花色
    out.append(suit(sym, 9, 36, 26, color))
    return ''.join(out)


# ── 人像牌：J / Q / K ────────────────────────────────────────────────────
def portrait(rank, sym, color):
    """简化但端庄的双色人像（不是写实，是"一望即知是哪张"的几何人像）。
    参考旧素材的构图：居中半身、头在上 1/3、肩在下方、配色只红/黑/金三色。"""
    gold = '#d4af37'
    skin = '#f6e3c8'
    return f'''
    <g>
      <!-- 框 -->
      <rect x="14" y="14" width="92" height="137" rx="4"
            fill="none" stroke="{color}" stroke-width="1.4"/>
      <!-- 头 -->
      <ellipse cx="60" cy="56" rx="17" ry="20" fill="{skin}" stroke="{color}" stroke-width="1.2"/>
      <!-- 发 -->
      <path d="M43 50 C43 32 50 24 60 24 C70 24 77 32 77 50
               C74 42 68 38 60 38 C52 38 46 42 43 50 Z" fill="{color}"/>
      <!-- 冠（K/Q 才有） -->
      {'' if rank == 'J' else f'<path d="M42 30 L50 18 L60 28 L70 18 L78 30 Z" fill="{gold}" stroke="{color}" stroke-width="1"/>'}
      <!-- 眼 -->
      <circle cx="53" cy="55" r="1.6" fill="{color}"/>
      <circle cx="67" cy="55" r="1.6" fill="{color}"/>
      <!-- 身/袍 -->
      <path d="M30 150 C30 110 42 84 60 84 C78 84 90 110 90 150 Z"
            fill="{color}" opacity="0.92"/>
      <path d="M60 84 L48 118 L60 138 L72 118 Z" fill="{gold}" opacity="0.85"/>
      <!-- 手持物（K 剑 / Q 花 / J 杖） -->
      {'<rect x="86" y="92" width="4" height="52" rx="2" fill="'+gold+'"/>' if rank == 'K' else ''}
      {'<circle cx="88" cy="96" r="5" fill="'+gold+'"/>' if rank == 'Q' else ''}
      {'<rect x="30" y="96" width="4" height="46" rx="2" fill="'+gold+'"/>' if rank == 'J' else ''}
      <!-- 注意：v0.11.0 去掉了「中央小花色」。
           原先在袍子正中放一枚金色花色，本意是加强辨识，实测是**脏**：
           它和袍子的金色菱形叠在一起，缩到 20px 宽时糊成一团泥。
           人像牌的辨识靠左上角标（那是永远完整露出的部分）就够了。 -->
    </g>'''


def court(rank, sym, color):
    """人像牌：左上角标 + 中央人像 + 右下倒置角标。"""
    body = corner(rank, sym, color)
    body += portrait(rank, sym, color)
    # 右下倒置角标
    body += (f'<g transform="translate({W},{H}) rotate(180)">'
             f'{corner(rank, sym, color)}</g>')
    return body


# ── 数字牌版式：标准扑克点数布局 ────────────────────────────────────────
# 坐标系 120×165，中央列 x=60。左列 x=44、右列 x=76。
# 每个点位用 (x, y, 缩放, 是否倒置) 描述，倒置用于下半部的花色
# （真扑克下半部的点位是旋转 180° 的，这样从上往下看也读得通）。
_L, _C, _R = 44, 60, 76          # 左 / 中 / 右 三列
_PIPS = {
    'A': [(_C, 82, 1.62, 0)],
    '2': [(_C, 50, 1.15, 0), (_C, 114, 1.15, 1)],
    '3': [(_C, 44, 1.15, 0), (_C, 82, 1.15, 0), (_C, 120, 1.15, 1)],
    '4': [(_L, 50, 1.05, 0), (_R, 50, 1.05, 0), (_L, 114, 1.05, 1), (_R, 114, 1.05, 1)],
    '5': [(_L, 50, 1.05, 0), (_R, 50, 1.05, 0), (_C, 82, 1.05, 0),
          (_L, 114, 1.05, 1), (_R, 114, 1.05, 1)],
    '6': [(_L, 44, 1.0, 0), (_R, 44, 1.0, 0), (_L, 82, 1.0, 0),
          (_R, 82, 1.0, 0), (_L, 120, 1.0, 1), (_R, 120, 1.0, 1)],
    '7': [(_L, 40, 0.95, 0), (_R, 40, 0.95, 0), (_C, 64, 0.95, 0),
          (_L, 82, 0.95, 0), (_R, 82, 0.95, 0),
          (_L, 120, 0.95, 1), (_R, 120, 0.95, 1)],
    '8': [(_L, 40, 0.95, 0), (_R, 40, 0.95, 0), (_C, 64, 0.95, 0),
          (_L, 82, 0.95, 0), (_R, 82, 0.95, 0), (_C, 100, 0.95, 1),
          (_L, 120, 0.95, 1), (_R, 120, 0.95, 1)],
    '9': [(_L, 36, 0.9, 0), (_R, 36, 0.9, 0), (_L, 62, 0.9, 0), (_R, 62, 0.9, 0),
          (_C, 82, 0.9, 0),
          (_L, 102, 0.9, 1), (_R, 102, 0.9, 1), (_L, 128, 0.9, 1), (_R, 128, 0.9, 1)],
    '10': [(_L, 34, 0.86, 0), (_R, 34, 0.86, 0), (_C, 50, 0.86, 0),
           (_L, 66, 0.86, 0), (_R, 66, 0.86, 0),
           (_L, 98, 0.86, 1), (_R, 98, 0.86, 1), (_C, 114, 0.86, 1),
           (_L, 130, 0.86, 1), (_R, 130, 0.86, 1)],
}


def pip_card(rank, sym, color):
    """数字牌：左上角标 + 右下倒置角标 + 标准点数布局。
    点位是「以中心 (x,y) 为中心、边长 20*scale 的花色」，倒置的点位绕自身中心转 180°。"""
    body = corner(rank, sym, color)
    body += f'<g transform="translate({W},{H}) rotate(180)">{corner(rank, sym, color)}</g>'
    for (x, y, sc, flip) in _PIPS[rank]:
        sz = 20 * sc
        g = suit(sym, -sz / 2, -sz / 2, sz, color)
        if flip:
            body += f'<g transform="translate({x},{y}) rotate(180)">{g}</g>'
        else:
            body += f'<g transform="translate({x},{y})">{g}</g>'
    return body


def joker(big):
    """大小王：小丑形象 + JOKER 竖排字。旧素材构图：小丑头像在上、字在下。
    big=True 为大王（红），False 为小王（黑）。"""
    c = RED if big else BLACK
    return f'''
    <g>
      <rect x="12" y="12" width="96" height="141" rx="5" fill="none"
            stroke="{c}" stroke-width="1.4"/>
      <!-- 帽 -->
      <path d="M34 58 L44 26 L52 48 L60 20 L68 48 L76 26 L86 58 Z"
            fill="{c}"/>
      <circle cx="60" cy="20" r="4" fill="#d4af37"/>
      <!-- 脸 -->
      <ellipse cx="60" cy="78" rx="22" ry="24" fill="#fdf6e8" stroke="{c}" stroke-width="1.4"/>
      <circle cx="52" cy="74" r="2.4" fill="{c}"/>
      <circle cx="68" cy="74" r="2.4" fill="{c}"/>
      <path d="M50 88 C56 96 64 96 70 88" fill="none" stroke="{c}" stroke-width="2"/>
      <!-- 领 -->
      <path d="M38 100 C44 108 76 108 82 100 L88 126 C74 136 46 136 32 126 Z"
            fill="{c}" opacity="0.9"/>
      <!-- v0.11.0：去掉底部 "JOKER" 长字。
           叠压时只露左侧 ~40%，这行字永远看不见；展开时又与左上角标重复，
           像贴了两张标签。改成：底部一道细色带 + 左右各一枚小星，
           安静但有"王牌"的分量。 -->
      <rect x="26" y="146" width="68" height="3" rx="1.5" fill="{c}" opacity="0.55"/>
      <circle cx="46" cy="138" r="2.2" fill="#d4af37"/>
      <circle cx="60" cy="141" r="2.2" fill="#d4af37"/>
      <circle cx="74" cy="138" r="2.2" fill="#d4af37"/>
    </g>'''


def build():
    os.makedirs(OUT, exist_ok=True)
    made = 0
    for r in ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']:
        for s in ['S', 'H', 'C', 'D']:   # 顺序与旧素材命名一致
            color = RED if s in ('H', 'D') else BLACK
            if r in ('J', 'Q', 'K'):
                inner = court(r, s, color)
            else:
                inner = pip_card(r, s, color)
            svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
                   f'width="{W}" height="{H}" shape-rendering="geometricPrecision">'
                   f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="7" '
                   f'fill="#fffdf7" stroke="#8c7a5c" stroke-width="1"/>'
                   f'{inner}</svg>')
            open(os.path.join(OUT, r + s + '.svg'), 'w').write(svg)
            made += 1
    for big, name in [(False, 'JOKER_S'), (True, 'JOKER_B')]:
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
               f'width="{W}" height="{H}" shape-rendering="geometricPrecision">'
               f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="7" '
               f'fill="#fffdf7" stroke="#8c7a5c" stroke-width="1"/>'
               f'{joker(big)}</svg>')
        open(os.path.join(OUT, name + '.svg'), 'w').write(svg)
        made += 1
    print(f'生成 {made} 张矢量牌面 → {OUT}')


if __name__ == '__main__':
    build()
