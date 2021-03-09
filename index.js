const path = require('path');
const RuleSet = require('webpack/lib/RuleSet');
const { isExistsPath, isAbsolutePath, isDev } = require('./utils');
const { name } = require('./package.json');

const PLUGIN_NAME = 'TransformI18nWebpackPlugin';
const getRegExp = str => new RegExp(`${name}(\\/|\\\\)loader(\\/|\\\\)for-${str}.js$`);

module.exports = class TransformI18nWebpackPlugin {
  constructor(opts) {
    const options = Object.assign({
      locale: null, // 默认excel第一列（中文）
      i18nPath: null, // required
      parseObjectProperty: false,
      parseBinaryExpression: false
    }, opts);
    if (!options.i18nPath) {
      throw new Error('TransformI18nWebpackPlugin: i18nPath is required!');
    }
    this.options = options;
    this.i18nList = new Map();
  }
  apply(compiler) {
    const generateZhPath = isDev();
    const rawRules = compiler.options.module.rules;
    const { rules } = new RuleSet(rawRules);
    const { i18nPath, locale, ...remainOptions } = this.options;

    const extraOptions = {
      generateZhPath,
      i18nPath: isExistsPath(isAbsolutePath(i18nPath) ? i18nPath : path.resolve(compiler.context, i18nPath))
    };

    setOptions(matcher(rules, getRegExp('js')), Object.assign(remainOptions, extraOptions));
    setOptions(matcher(rules, getRegExp('vue')), extraOptions);
    setOptions(matcher(rules, getRegExp('excel')), { locale });

    compiler.options.module.rules = rules;

    // 获取compilation
    compiler.hooks.compilation.tap(PLUGIN_NAME, compilation => {
      // 给ctx添加变量，以便loader能够获取它
      compilation.hooks.normalModuleLoader.tap(
        PLUGIN_NAME,
        ctx => {
          ctx.i18nList = this.i18nList;
        },
      );
    });

    if (generateZhPath) {
      compiler.hooks.emit.tapPromise(PLUGIN_NAME, async compilation => {
        const { modules, assets } = compilation;
        const { i18nList } = this;
        const resourceObj = modules.reduce((pre, { resource }) => {
          if (resource) {
            pre[resource] = true;
          }
          return pre;
        }, {});
        const effectiveResource = [...i18nList.keys()].filter(k => resourceObj[k]);

        // 该项目中收集到的中文及其hash
        const finalI18nList = Array.from(effectiveResource.reduce((map, k) => {
          i18nList.get(k).forEach(([key, value]) => {
            map.set(key, value);
          });
          return map;
        }, new Map()).values());

        let existI18nData = [];

        // 从modules中寻找当前项目是否使用excel来配置翻译文件
        const zhLocale = modules.find(m => /\.xlsx?\?lang=\w+?&default=1$/.test(m.id));
        // 如果有，则将已翻译的中文和当前项目中收集到的中文进行diff
        if (zhLocale) {
          existI18nData = Object.values(eval(`(() => {${zhLocale._source._value.trim().replace(/export default result;$/, 'return result')}})()`));
        }

        // 初始化， 默认每次都是新增
        const { add, reduce, common } = i18nDiff(finalI18nList, existI18nData);

        const i18nHtml = `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta http-equiv="X-UA-Compatible" content="IE=edge">
            <meta name="viewport" content="width=device-width,initial-scale=1.0">
            <title>i18n中文列表</title>
          </head>
          <body>
            <style>
            * {
                padding: 0;
                margin: 0;
              }
              ul {
                list-style: none;
              }
              li {
                border-bottom: 1px dashed #ccc;
                padding-left: 10px;
                line-height: 24px;
                font-size: 14px;
              }
              .add {
                background-color: #ecfdf0;
              }
              .reduce {
                background-color: #fbe9eb;
              }
              pre {
                font-family: Microsoft YaHei;
              }
              .total-bar {
                padding: 10px;
                background-color: #000;
                color: #fff;
                user-select: none;
              }
              .total-bar span {
                margin-left: 10px;
                margin-right: 10px;
              }
            </style>
            <p class="total-bar">
              <span>新增数量：${add.length}</span>
              <span>减少数量：${reduce.length}</span>
              <span>${add.length || reduce.length ? '相同' : '总'}数量：${common.length}</span>
            </p>
            <ul>
            ${generateHtml(add, 'add')}
            ${generateHtml(reduce, 'reduce')}
            ${generateHtml(common, '')}
            </ul>
          </body>
        </html>
        `;

        assets['i18n.html'] = {
          source: () => i18nHtml,
          size: () => i18nHtml.length
        };
      });
    }
  }
};

function setOptions(rules, options = {}) {
  rules.forEach(rule => {
    rule.options = {
      ...(rule.options || {}),
      ...options
    };
  });
}

// 转义html
function escapeHTML(str) {
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 生成html
function generateHtml(array, className) {
  return array.map(str => `<li class="${className}"><pre>${escapeHTML(str)}</pre></li>`).join('');
}

function matcher(rules, regExp) {
  return rules.reduce((pre, { use, oneOf }) => {
    if (oneOf) {
      pre.push(...matcher(oneOf, regExp));
    } else if (use) {
      const loader = use.find(u => regExp.test(u.loader));
      if (loader) {
        pre.push(loader);
      }
    }
    return pre;
  }, []);
}

// 根据两组数据，得到它们的交集差集
function i18nDiff(currentData = [], compareData = []) {
  const result = {
    reduce: [],
    common: [],
    add: []
  };

  // 如果比较数据为空数组，则当前数据全为新增
  if (!compareData.length) {
    result.add = currentData;
    return result;
  }

  // 如果当前数据为空，则比较数据全为减少的
  if (!currentData.length) {
    result.reduce = compareData;
    return result;
  }

  const commonData = result.common;
  const addData = result.add;
  const copyCompareData = [...compareData];

  for (let i = 0, len = currentData.length; i < len; i++) {
    const current = currentData[i];
    let index = -1;
    for (let j = 0, len2 = copyCompareData.length; j < len2; j++) {
      if (copyCompareData[j] === current) {
        index = j;
        break;
      }
    }
    // 如果两个数组中都有该项，则添加到commonData，并且删除copyCompareData中的对应项
    if (index > -1) {
      copyCompareData.splice(index, 1);
      commonData.push(current);
    } else {
      // 则表示当前项为新增项
      addData.push(current);
    }
  }

  // 最后如果copyCompareData还有剩余，则是减少的
  result.reduce = copyCompareData;
  return result;
}
