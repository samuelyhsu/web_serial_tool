// 必须排在第一位：它安装运行环境，而下面这些模块一被求值就会去用它。
// 顺序不是风格问题，是正确性问题 —— 详见 bootstrap.ts 的注释。
import './bootstrap';
import { attachView } from './bootstrap';
import * as view from './applySnapshot';
import { mount } from './mount';

attachView(view);
mount();
