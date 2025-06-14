import { IsUrl } from 'class-validator';

export class ScanUrlQueryDto {
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  url: string;
}
