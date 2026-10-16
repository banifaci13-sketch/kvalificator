<?php
/**
 * Plugin Name: Soroka — квалификатор лидов
 * Description: Виджет-квалификатор заявок Soroka Marketing. Настройки: «Настройки → Квалификатор».
 * Version: 0.1.0
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * Author: Soroka Marketing
 * Text Domain: soroka-kvalificator
 */

if (!defined('ABSPATH')) {
    exit;
}

const SOROKA_KVAL_OPTION = 'soroka_kval_settings';

function soroka_kval_defaults() {
    return array(
        'server'    => '',
        'enabled'   => '1',
        'button'    => 'Обсудить задачу',
        'title'     => 'Soroka Marketing',
        'subtitle'  => 'Давайте обсудим вашу задачу',
        'color'     => '#143a6b',
        'accent'    => '#17b3d6',
        'position'  => 'right',
        'metrika'   => '',
        'exclude'   => '',
    );
}

function soroka_kval_settings() {
    return wp_parse_args(get_option(SOROKA_KVAL_OPTION, array()), soroka_kval_defaults());
}

/** Страницы, где виджет не нужен (политика, корзина и т.п.): по одному пути в строке. */
function soroka_kval_is_excluded($exclude) {
    $path = wp_parse_url(isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '/', PHP_URL_PATH);
    foreach (preg_split('/\R/', (string) $exclude) as $line) {
        $line = trim($line);
        if ($line !== '' && strpos((string) $path, $line) === 0) {
            return true;
        }
    }
    return false;
}

add_action('wp_enqueue_scripts', function () {
    $s = soroka_kval_settings();
    if ($s['enabled'] !== '1' || $s['server'] === '' || is_admin() || soroka_kval_is_excluded($s['exclude'])) {
        return;
    }
    wp_enqueue_script(
        'soroka-kvalificator',
        trailingslashit($s['server']) . 'widget.js',
        array(),
        null,
        array('in_footer' => true, 'strategy' => 'defer')
    );
});

// data-атрибуты для настроек виджета
add_filter('script_loader_tag', function ($tag, $handle) {
    if ($handle !== 'soroka-kvalificator') {
        return $tag;
    }
    $s = soroka_kval_settings();
    $attrs = array(
        'data-button'   => $s['button'],
        'data-title'    => $s['title'],
        'data-subtitle' => $s['subtitle'],
        'data-color'    => $s['color'],
        'data-accent'   => $s['accent'],
        'data-position' => $s['position'],
        'data-metrika'  => $s['metrika'],
    );
    $html = '';
    foreach ($attrs as $name => $value) {
        if ($value !== '') {
            $html .= ' ' . $name . '="' . esc_attr($value) . '"';
        }
    }
    return str_replace(' src=', $html . ' src=', $tag);
}, 10, 2);

// ---------- страница настроек ----------

add_action('admin_menu', function () {
    add_options_page('Квалификатор лидов', 'Квалификатор', 'manage_options', 'soroka-kvalificator', 'soroka_kval_render_settings');
});

add_action('admin_init', function () {
    register_setting('soroka_kval', SOROKA_KVAL_OPTION, array(
        'type'              => 'array',
        'sanitize_callback' => 'soroka_kval_sanitize',
        'default'           => soroka_kval_defaults(),
    ));
});

function soroka_kval_sanitize($input) {
    $d = soroka_kval_defaults();
    $color = function ($v, $fallback) {
        $v = sanitize_hex_color($v);
        return $v ? $v : $fallback;
    };
    return array(
        'server'   => untrailingslashit(esc_url_raw(isset($input['server']) ? $input['server'] : '', array('https', 'http'))),
        'enabled'  => empty($input['enabled']) ? '0' : '1',
        'button'   => sanitize_text_field(isset($input['button']) ? $input['button'] : $d['button']),
        'title'    => sanitize_text_field(isset($input['title']) ? $input['title'] : $d['title']),
        'subtitle' => sanitize_text_field(isset($input['subtitle']) ? $input['subtitle'] : $d['subtitle']),
        'color'    => $color(isset($input['color']) ? $input['color'] : '', $d['color']),
        'accent'   => $color(isset($input['accent']) ? $input['accent'] : '', $d['accent']),
        'position' => (isset($input['position']) && $input['position'] === 'left') ? 'left' : 'right',
        'metrika'  => preg_replace('/\D/', '', isset($input['metrika']) ? $input['metrika'] : ''),
        'exclude'  => sanitize_textarea_field(isset($input['exclude']) ? $input['exclude'] : ''),
    );
}

function soroka_kval_render_settings() {
    if (!current_user_can('manage_options')) {
        return;
    }
    $s = soroka_kval_settings();
    $name = function ($key) {
        return esc_attr(SOROKA_KVAL_OPTION . '[' . $key . ']');
    };
    ?>
    <div class="wrap">
        <h1>Квалификатор лидов</h1>
        <form method="post" action="options.php">
            <?php settings_fields('soroka_kval'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="kv-server">Адрес сервера квалификатора</label></th>
                    <td><input id="kv-server" type="url" class="regular-text" name="<?php echo $name('server'); ?>" value="<?php echo esc_attr($s['server']); ?>" placeholder="https://kval.soroka-marketing.ru" required>
                    <p class="description">Без этого адреса виджет не показывается.</p></td>
                </tr>
                <tr>
                    <th scope="row">Показывать виджет</th>
                    <td><label><input type="checkbox" name="<?php echo $name('enabled'); ?>" value="1" <?php checked($s['enabled'], '1'); ?>> Включён</label></td>
                </tr>
                <tr>
                    <th scope="row"><label for="kv-button">Текст кнопки</label></th>
                    <td><input id="kv-button" type="text" class="regular-text" name="<?php echo $name('button'); ?>" value="<?php echo esc_attr($s['button']); ?>"></td>
                </tr>
                <tr>
                    <th scope="row"><label for="kv-title">Заголовок окна</label></th>
                    <td><input id="kv-title" type="text" class="regular-text" name="<?php echo $name('title'); ?>" value="<?php echo esc_attr($s['title']); ?>"></td>
                </tr>
                <tr>
                    <th scope="row"><label for="kv-subtitle">Подзаголовок</label></th>
                    <td><input id="kv-subtitle" type="text" class="regular-text" name="<?php echo $name('subtitle'); ?>" value="<?php echo esc_attr($s['subtitle']); ?>"></td>
                </tr>
                <tr>
                    <th scope="row">Цвета</th>
                    <td>
                        <label>Основной <input type="color" name="<?php echo $name('color'); ?>" value="<?php echo esc_attr($s['color']); ?>"></label>
                        &nbsp; <label>Акцент <input type="color" name="<?php echo $name('accent'); ?>" value="<?php echo esc_attr($s['accent']); ?>"></label>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Положение</th>
                    <td>
                        <label><input type="radio" name="<?php echo $name('position'); ?>" value="right" <?php checked($s['position'], 'right'); ?>> Справа</label>
                        &nbsp; <label><input type="radio" name="<?php echo $name('position'); ?>" value="left" <?php checked($s['position'], 'left'); ?>> Слева</label>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="kv-metrika">Номер счётчика Яндекс.Метрики</label></th>
                    <td><input id="kv-metrika" type="text" inputmode="numeric" name="<?php echo $name('metrika'); ?>" value="<?php echo esc_attr($s['metrika']); ?>">
                    <p class="description">Цели: kval_open, kval_start, kval_step_&lt;вопрос&gt;, kval_lead, kval_handoff.</p></td>
                </tr>
                <tr>
                    <th scope="row"><label for="kv-exclude">Не показывать на страницах</label></th>
                    <td><textarea id="kv-exclude" class="large-text" rows="3" name="<?php echo $name('exclude'); ?>" placeholder="/privacy/"><?php echo esc_textarea($s['exclude']); ?></textarea>
                    <p class="description">По одному пути в строке, например <code>/privacy/</code>.</p></td>
                </tr>
            </table>
            <p>Открыть виджет из любой кнопки сайта: ссылка <code>#kvalificator</code> или атрибут <code>data-kval-open</code>.</p>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
