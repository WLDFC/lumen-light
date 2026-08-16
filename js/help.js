/**
 * ==========================================================================
 * LumenLight 使用教程页脚本（help.html 专用）
 * 职责：
 *   1. 扫描正文里的 h2 章节，自动生成左侧大纲目录；
 *   2. 滚动时高亮当前阅读到的章节（scroll-spy）；
 *   3. 点击目录平滑滚动到对应章节。
 * 无任何外部依赖。
 * ==========================================================================
 */

(function () {
    'use strict';

    const content = document.querySelector('.help-content');
    const toc = document.querySelector('.help-toc');
    if (!content || !toc) return;

    // 从 h2 章节生成目录（标题文本即目录项文本）
    const headings = content.querySelectorAll('h2[data-toc]');
    const links = [];
    headings.forEach((h, i) => {
        h.id = h.id || ('section-' + (i + 1));
        const a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.dataset.toc || h.textContent;
        toc.appendChild(a);
        links.push({ a, h });
    });

    // 滚动高亮：当前视口顶部以下最近的章节视为"正在阅读"
    function updateActive() {
        const mark = 90;   // 顶栏高度 + 余量
        let current = links[0];
        for (const item of links) {
            if (item.h.getBoundingClientRect().top <= mark) current = item;
        }
        links.forEach(({ a }) => a.classList.remove('active'));
        if (current) current.a.classList.add('active');
    }

    window.addEventListener('scroll', updateActive, { passive: true });
    window.addEventListener('resize', updateActive);
    updateActive();

    // ---------- 灯箱：点击配图全屏查看大图 ----------
    // 事件委托：img 点击 → 全屏遮罩 + 原图；点击遮罩/关闭按钮/ESC 关闭
    const lightbox = document.createElement('div');
    lightbox.className = 'help-lightbox';
    lightbox.style.display = 'none';
    lightbox.innerHTML = '<span class="help-lightbox-close">×</span><img alt="查看大图">';
    document.body.appendChild(lightbox);
    const lbImg = lightbox.querySelector('img');

    function closeLightbox() {
        lightbox.style.display = 'none';
        lbImg.src = '';
        document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) {
        if (e.key === 'Escape') closeLightbox();
    }

    content.addEventListener('click', (e) => {
        const img = e.target.closest('.help-figure img');
        if (!img) return;
        lbImg.src = img.src;
        lightbox.style.display = 'flex';
        document.addEventListener('keydown', onEsc);
    });
    lightbox.addEventListener('click', (e) => {
        // 点图片本身不关闭（方便拖动滚动条看细节），点遮罩/×关闭
        if (e.target === lbImg) return;
        closeLightbox();
    });
})();
