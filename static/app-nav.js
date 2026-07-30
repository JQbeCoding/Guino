(function () {
    function init() {
    const MOBILE_MQ = window.matchMedia('(max-width: 767px)');

    function initNav(nav) {
        const toggle = nav.querySelector('[data-guino-nav-toggle]');
        const panel = nav.querySelector('[data-guino-nav-panel]');
        if (!toggle || !panel) return;

        const iconMenu = toggle.querySelector('[data-guino-nav-icon-menu]');
        const iconClose = toggle.querySelector('[data-guino-nav-icon-close]');

        function setOpen(open) {
            nav.classList.toggle('nav-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
            if (iconMenu) iconMenu.classList.toggle('hidden', open);
            if (iconClose) iconClose.classList.toggle('hidden', !open);
            if (!MOBILE_MQ.matches) {
                panel.classList.remove('flex');
                panel.classList.add('hidden');
                return;
            }
            panel.classList.toggle('hidden', !open);
            panel.classList.toggle('flex', open);
        }

        function syncForViewport() {
            if (!MOBILE_MQ.matches) {
                nav.classList.remove('nav-open');
                panel.classList.remove('flex');
                panel.classList.add('hidden');
                toggle.setAttribute('aria-expanded', 'false');
                if (iconMenu) iconMenu.classList.remove('hidden');
                if (iconClose) iconClose.classList.add('hidden');
            } else if (!nav.classList.contains('nav-open')) {
                panel.classList.add('hidden');
                panel.classList.remove('flex');
            }
        }

        toggle.addEventListener('click', () => {
            setOpen(!nav.classList.contains('nav-open'));
        });

        panel.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (link && MOBILE_MQ.matches) setOpen(false);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && nav.classList.contains('nav-open')) setOpen(false);
        });

        MOBILE_MQ.addEventListener('change', syncForViewport);
        syncForViewport();
    }

    document.querySelectorAll('[data-guino-nav]').forEach(initNav);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
