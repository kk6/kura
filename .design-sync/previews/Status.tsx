import { Status } from 'kura'

export const Error = () => <Status kind="error">ゴミ箱に移せませんでした（12件）</Status>
export const Warning = () => <Status kind="warning">3件は元のファイルが見つかりません</Status>
export const Success = () => <Status kind="success">48件を取り込みました</Status>
export const Info = () => <Status kind="info">サムネイルを作っています</Status>
