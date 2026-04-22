import { Directive, ElementRef, Renderer2, input, effect, inject } from '@angular/core';

/**
 * Signals-based structural attribute directive example.
 * Usage: <div [appHighlight]="isActive()" [highlightColor]="'yellow'">
 */
@Directive({
  selector: '[appHighlight]',
  standalone: true
})
export class HighlightDirective {
  appHighlight = input.required<boolean>();
  highlightColor = input<string>('yellow');

  private el = inject(ElementRef);
  private renderer = inject(Renderer2);

  constructor() {
    effect(() => {
      const isActive = this.appHighlight();
      const color = this.highlightColor();

      if (isActive) {
        this.renderer.setStyle(this.el.nativeElement, 'backgroundColor', color);
      } else {
        this.renderer.removeStyle(this.el.nativeElement, 'backgroundColor');
      }
    });
  }
}
