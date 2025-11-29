 document.addEventListener('DOMContentLoaded', function () {
            var fallbackBg = 'assets/images/hero-bg-1.jpg';

            function applyBackgrounds() {
                document.querySelectorAll('.hero-slide').forEach(function (slide) {
                    var bg = slide.getAttribute('data-bg') || fallbackBg;
                    var img = new Image();
                    img.onload = function () {
                        slide.style.backgroundImage = "url('" + bg + "')";
                    };
                    img.onerror = function () {
                        slide.style.backgroundImage = "url('" + fallbackBg + "')";
                    };
                    img.src = bg;
                });
            }

            function resetAnimations(slideEl) {
                if (!slideEl) return;
                slideEl.querySelectorAll('.hero-title, .hero-subtitle, .hero-cta').forEach(function (el) {
                    el.classList.remove('is-visible', 'animate__animated', 'animate__fadeInLeft', 'animate__fadeInUp');
                    void el.offsetWidth;
                });
            }

            function playAnimations(slideEl) {
                if (!slideEl) return;
                var title = slideEl.querySelector('.hero-title');
                var subtitle = slideEl.querySelector('.hero-subtitle');
                var cta = slideEl.querySelector('.hero-cta');

                setTimeout(function () {
                    [title, subtitle].forEach(function (el) {
                        if (!el) return;
                        el.classList.add('is-visible', 'animate__animated', 'animate__fadeInLeft');
                    });
                }, 100);

                setTimeout(function () {
                    if (!cta) return;
                    cta.classList.add('is-visible', 'animate__animated', 'animate__fadeInUp');
                }, 300);
            }

            applyBackgrounds();

            var swiper = new Swiper('.hero-swiper', {
                loop: true,
                speed: 800,
                effect: 'fade',
                fadeEffect: { crossFade: true },
                autoplay: {
                    delay: 5000,
                    disableOnInteraction: false
                },
                pagination: {
                    el: '.hero-pagination',
                    clickable: true
                },
                navigation: {
                    nextEl: '.swiper-button-next',
                    prevEl: '.swiper-button-prev'
                },
                on: {
                    init: function () {
                        var activeSlide = this.slides[this.activeIndex];
                        resetAnimations(activeSlide);
                        playAnimations(activeSlide);
                    },
                    slideChangeTransitionStart: function () {
                        var activeSlide = this.slides[this.activeIndex];
                        resetAnimations(activeSlide);
                        playAnimations(activeSlide);
                    }
                }
            });
            window.heroSwiper = swiper;

            var ratings = document.querySelector('.ratings_container');
            if (ratings) {
                var played = false;
                ratings.style.opacity = '0';
                function triggerRatings() {
                    if (played) return;
                    played = true;
                    ratings.classList.add('animate__animated', 'animate__fadeInDown');
                    ratings.style.opacity = '1';

                    var counters = ratings.querySelectorAll('.ratings_title');
                    function parseTextParts(t){
                        var m = String(t).trim().match(/^(\D*)?(\d+)(.*)$/);
                        if (!m) return {prefix: '', number: 0, suffix: ''};
                        return { prefix: m[1] || '', number: parseInt(m[2], 10) || 0, suffix: m[3] || '' };
                    }
                    function animateCounter(el, target, prefix, suffix, duration){
                        var start = 0;
                        var startTime = null;
                        function step(ts){
                            if (!startTime) startTime = ts;
                            var p = Math.min((ts - startTime) / duration, 1);
                            var val = Math.floor(start + (target - start) * p);
                            el.textContent = (prefix || '') + String(val) + (suffix || '');
                            if (p < 1) requestAnimationFrame(step);
                            else el.textContent = (prefix || '') + String(target) + (suffix || '');
                        }
                        requestAnimationFrame(step);
                    }
                    counters.forEach(function(el){
                        var parts = parseTextParts(el.textContent);
                        animateCounter(el, parts.number, parts.prefix, parts.suffix, 2000);
                    });
                }
                if ('IntersectionObserver' in window) {
                    var robs = new IntersectionObserver(function(entries, obs){
                        entries.forEach(function(entry){
                            if (entry.isIntersecting && !played) {
                                triggerRatings();
                                obs.unobserve(entry.target);
                            }
                        });
                    }, { root: null, threshold: 0.2 });
                    robs.observe(ratings);
                } else {
                    triggerRatings();
                }
            }

            function setupOnceAnimate(selector, animationName, threshold) {
                var nodes = document.querySelectorAll(selector);
                if (!nodes.length) return;
                nodes.forEach(function(el){ el.style.opacity = '0'; });
                function play(el){
                    if (el.__oncePlayed) return;
                    el.__oncePlayed = true;
                    el.classList.add('animate__animated', 'animate__' + animationName);
                    el.style.opacity = '1';
                }
                if ('IntersectionObserver' in window) {
                    var io = new IntersectionObserver(function(entries){
                        entries.forEach(function(entry){
                            if (entry.isIntersecting) {
                                play(entry.target);
                                io.unobserve(entry.target);
                            }
                        });
                    }, { root: null, threshold: threshold || 0.2 });
                    nodes.forEach(function(n){ io.observe(n); });
                } else {
                    nodes.forEach(play);
                }
            }

            setupOnceAnimate('.once-fadeInLeft', 'fadeInLeft', 0.2);
            setupOnceAnimate('.once-fadeInUp', 'fadeInUp', 0.2);
            setupOnceAnimate('.once-fadeInRight', 'fadeInRight', 0.2);
        });