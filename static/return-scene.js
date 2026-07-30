(function () {
    const DURATION = 1300;

    function playReturnAnimation(href) {
        const dark = localStorage.getItem('guino_theme') === 'dark';
        const bg = dark ? '#0D1117' : '#E8F1F5';
        const text = dark ? '#F5F5F0' : '#1C1C1C';

        if (!document.getElementById('guino-return-styles')) {
            const style = document.createElement('style');
            style.id = 'guino-return-styles';
            style.textContent = `
                @keyframes guino-return-waddle {
                    from { transform: rotate(-8deg) translateY(0); }
                    to { transform: rotate(8deg) translateY(-4px); }
                }
                @keyframes guino-return-fadein {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        const overlay = document.createElement('div');
        overlay.setAttribute('aria-live', 'polite');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 9999;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            background: ${bg}; animation: guino-return-fadein 0.25s ease;
        `;
        overlay.innerHTML = `
            <p style="font: bold 1.25rem ui-sans-serif, system-ui, sans-serif; color: ${text}; margin: 0 0 1rem;">Waddling back to the ice...</p>
            <div style="font-size: 3rem; animation: guino-return-waddle 0.5s ease-in-out infinite alternate;">🐧</div>
            <div style="width: 220px; height: 6px; background: rgba(92,107,115,0.25); margin-top: 1.5rem; border-radius: 3px; overflow: hidden;">
                <div id="guino-return-bar" style="height: 100%; width: 0; background: #F4A227; border-radius: 3px;"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
            const bar = document.getElementById('guino-return-bar');
            if (bar) {
                bar.style.transition = `width ${DURATION}ms linear`;
                bar.style.width = '100%';
            }
        });

        sessionStorage.setItem('guino_scene_return', '1');
        setTimeout(() => { window.location.href = href; }, DURATION);
    }

    document.addEventListener('click', (e) => {
        const link = e.target.closest('[data-guino-return]');
        if (!link) return;
        e.preventDefault();
        playReturnAnimation(link.getAttribute('href') || '/');
    });
})();
