import { Component, input, output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

interface Props {
  // Define your inputs/outputs interface here
}

@Component({
  selector: 'app-example',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (data()) {
      <div>{{ data().title }}</div>
    } @else {
      <p>No data available</p>
    }
  `,
  styles: [`
    :host { display: block; }
  `]
})
export class ExampleComponent {
  // Inputs
  data = input.required<any>();
  disabled = input<boolean>(false);

  // Outputs
  onAction = output<void>();

  // Dependencies
  // private service = inject(MyService);

  handleClick() {
    this.onAction.emit();
  }
}
